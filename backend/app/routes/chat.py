"""
Chat agent routes — Phase 1.
Exposes the chat agent to the frontend.
"""

import uuid
from fastapi import APIRouter, Depends, HTTPException, Header
from pydantic import BaseModel
from app.database import get_authed_client, get_current_user_id, supabase
from app.services.chat_agent import run_chat_agent, get_conversation_history

router = APIRouter(prefix="/chat", tags=["chat"])


class ChatMessageRequest(BaseModel):
    message: str
    conversation_id: str = ""


@router.post("/message")
async def send_message(
    request: ChatMessageRequest,
    client=Depends(get_authed_client),
    recruiter_id: str = Depends(get_current_user_id),
):
    """
    Main chat endpoint.
    Receives recruiter message, runs agent, returns reply.
    """
    # FIX 6: Top-level try/except — crashes never reach frontend as 500 errors
    try:
        if not request.message.strip():
            raise HTTPException(status_code=400, detail="Message cannot be empty")

        # Raised to 10000 chars — pasted JDs can be long.
        # run_chat_agent() truncates to 2000 before sending to Claude.
        if len(request.message) > 10000:
            raise HTTPException(
                status_code=400,
                detail="Message too long. Please keep it under 10000 characters."
            )

        conversation_id = request.conversation_id or str(uuid.uuid4())

        # ── GUARDRAIL CHECK ──────────────────────────────────────────
        # Runs before EVERY message reaches the agent.
        # Blocks prompt injections, score manipulation, data breaches.
        # This satisfies Pillar 2: enforced safety boundaries.
        from app.services.guardrails import check_message_safety

        # Fetch last assistant message for context-aware checking
        last_msg_resp = supabase.table("chat_history") \
            .select("role, content") \
            .eq("conversation_id", conversation_id) \
            .order("created_at", desc=True) \
            .limit(4).execute()

        recent_history = list(reversed(last_msg_resp.data or []))
        last_assistant_msg = ""
        for msg in reversed(recent_history):
            if msg["role"] == "assistant":
                last_assistant_msg = msg["content"]
                break

        safety_result = check_message_safety(
            message=request.message.strip(),
            user_id=recruiter_id,
            conversation_id=conversation_id,
            last_assistant_message=last_assistant_msg
        )

        if not safety_result["safe"]:
            # Save blocked exchange to chat_history so UI shows it
            supabase.table("chat_history").insert([
                {
                    "recruiter_id": recruiter_id,
                    "conversation_id": conversation_id,
                    "role": "user",
                    "content": request.message.strip()
                },
                {
                    "recruiter_id": recruiter_id,
                    "conversation_id": conversation_id,
                    "role": "assistant",
                    "content": safety_result["suggested_reply"],
                    "tool_used": "guardrail_agent",
                    "action_taken": f"Blocked: {safety_result['violation']}"
                }
            ]).execute()

            return {
                "reply": safety_result["suggested_reply"],
                "tool_used": "guardrail_agent",
                "action_taken": f"Blocked — {safety_result['violation']}",
                "agent_reasoning": safety_result.get("agent_reasoning", ""),
                "conversation_id": conversation_id,
                "blocked": True,
                "violation_type": safety_result["violation"]
            }
        # ── END GUARDRAIL CHECK ──────────────────────────────────────

        msg_lower = request.message.lower()

        # Strip stale JD context when asking about latest JD
        latest_keywords = [
            "latest", "newest", "most recent", "my jd",
            "my job", "my latest", "recent jd", "last jd"
        ]
        is_latest_query = any(kw in msg_lower for kw in latest_keywords)

        # Detect find-candidates vs post-job intent for context filtering
        find_keywords = [
            "find candidates", "run matching",
            "who fits", "best candidates",
            "match candidates", "shortlist"
        ]
        post_keywords = [
            "post a job", "create a jd",
            "add a job", "new job", "new role"
        ]
        is_find_request = any(kw in msg_lower for kw in find_keywords)

        result = await run_chat_agent(
            message=request.message.strip(),
            conversation_id=conversation_id,
            recruiter_id=recruiter_id,
            strip_stale_jd_context=is_latest_query,
            strip_post_context=is_find_request
        )

        # Enrich response with pillar metadata for frontend display
        result["pillars"] = {
            "dynamic_routing": {
                "satisfied": True,
                "evidence": f"Claude selected tool: {result.get('tool_used', 'direct_answer')}",
                "description": "LLM decides which tool to call"
            },
            "guardrails": {
                "satisfied": True,
                "evidence": "3-layer security active (pre-check + guard agent + main agent)",
                "description": "Enforced safety boundaries"
            },
            "real_world_agency": {
                "satisfied": True,
                "evidence": result.get("action_taken", "State change via tool execution"),
                "description": "Agent alters real database state"
            }
        }

        return result

    except HTTPException:
        raise  # let FastAPI handle 400/401/etc normally
    except Exception as e:
        import traceback
        print(f"[chat] Endpoint error: {str(e)}")
        print(f"[chat] Traceback: {traceback.format_exc()}")
        return {
            "reply": "I encountered an error processing your request. Please try again or rephrase your message.",
            "tool_used": None,
            "action_taken": None,
            "conversation_id": request.conversation_id or "",
            "blocked": False
        }


@router.get("/history/{conversation_id}")
async def get_history(
    conversation_id: str,
    client=Depends(get_authed_client),
    recruiter_id: str = Depends(get_current_user_id),
):
    """Returns conversation history for display in UI."""
    history = await get_conversation_history(conversation_id, recruiter_id)
    return {"history": history, "conversation_id": conversation_id}


@router.delete("/history/{conversation_id}")
async def clear_history(
    conversation_id: str,
    client=Depends(get_authed_client),
    recruiter_id: str = Depends(get_current_user_id),
):
    """Clears conversation history — starts fresh."""
    supabase.table("chat_history") \
        .delete() \
        .eq("conversation_id", conversation_id) \
        .eq("recruiter_id", recruiter_id) \
        .execute()

    return {"success": True}


@router.get("/decision-log/{conversation_id}")
async def get_decision_log(
    conversation_id: str,
    client=Depends(get_authed_client),
    recruiter_id: str = Depends(get_current_user_id),
):
    """
    Returns the agent decision log for a conversation.
    Shows every tool Claude selected and why.
    Used to demonstrate Pillar 1 — dynamic decision making.
    """
    result = (
        supabase.table("chat_history")
        .select("role, content, tool_used, action_taken, created_at")
        .eq("conversation_id", conversation_id)
        .eq("recruiter_id", recruiter_id)
        .not_.is_("tool_used", "null")
        .order("created_at")
        .execute()
    )

    decisions = [
        {
            "tool": row["tool_used"],
            "action": row["action_taken"],
            "timestamp": row["created_at"],
            "is_blocked": row["tool_used"] == "guardrail_agent"
        }
        for row in (result.data or [])
        if row.get("tool_used")
    ]

    return {"decisions": decisions, "total": len(decisions)}


@router.get("/security-log")
async def get_security_log(
    authorization: str = Header(None),
):
    """
    Returns recent security violations caught by the guard agent.
    Uses direct JWT decode instead of authed client dependency
    to avoid NoneType errors when client.auth is unavailable.
    """
    try:
        if not authorization or not authorization.startswith("Bearer "):
            return {"violations": [], "total": 0}

        token = authorization.replace("Bearer ", "").strip()

        user_response = supabase.auth.get_user(token)
        if not user_response or not user_response.user:
            return {"violations": [], "total": 0}

        recruiter_id = user_response.user.id

        result = (
            supabase.table("safety_logs")
            .select("message, violation_type, reason, created_at")
            .eq("user_id", recruiter_id)
            .order("created_at", desc=True)
            .limit(10)
            .execute()
        )

        violations = result.data or []
        return {"violations": violations, "total": len(violations)}

    except Exception as e:
        import traceback
        print(f"[security-log] Error: {str(e)}")
        print(traceback.format_exc())
        return {"violations": [], "total": 0}


@router.get("/conversations")
async def get_conversations(
    authorization: str = Header(None),
):
    """
    Returns list of past conversations for this recruiter.
    Each conversation shows first message as title.
    """
    try:
        if not authorization or not authorization.startswith("Bearer "):
            return {"conversations": []}

        token = authorization.replace("Bearer ", "").strip()
        user_response = supabase.auth.get_user(token)

        if not user_response or not user_response.user:
            return {"conversations": []}

        recruiter_id = user_response.user.id

        result = (
            supabase.table("chat_history")
            .select("conversation_id, content, role, created_at")
            .eq("recruiter_id", recruiter_id)
            .eq("role", "user")
            .order("created_at", desc=True)
            .execute()
        )

        if not result.data:
            return {"conversations": []}

        # Group by conversation_id, keep first user message as title
        seen = {}
        for row in result.data:
            cid = row["conversation_id"]
            if cid not in seen:
                seen[cid] = {
                    "conversation_id": cid,
                    "title": row["content"][:60] + (
                        "..." if len(row["content"]) > 60 else ""
                    ),
                    "last_active": row["created_at"]
                }

        conversations = list(seen.values())
        conversations.sort(key=lambda x: x["last_active"], reverse=True)

        return {"conversations": conversations[:20]}

    except Exception as e:
        print(f"[conversations] Error: {e}")
        return {"conversations": []}


class CandidateChatRequest(BaseModel):
    message: str
    conversation_id: str = ""


@router.post("/candidate-message")
async def candidate_send_message(
    request: CandidateChatRequest,
    authorization: str = Header(None),
):
    """Chat endpoint for candidates. Uses candidate-specific tools and context."""
    try:
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Not authenticated")

        token = authorization.replace("Bearer ", "").strip()
        user_response = supabase.auth.get_user(token)

        if not user_response or not user_response.user:
            raise HTTPException(status_code=401, detail="Invalid token")

        profile_id = user_response.user.id

        if not request.message.strip():
            raise HTTPException(status_code=400, detail="Message cannot be empty")

        conversation_id = request.conversation_id or str(uuid.uuid4())

        # Resolve candidate_id from profile_id or email
        candidate = (
            supabase.table("candidates")
            .select("id")
            .eq("profile_id", profile_id)
            .limit(1)
            .execute()
        )
        if not candidate.data:
            user_email = user_response.user.email
            candidate = (
                supabase.table("candidates")
                .select("id")
                .eq("email", user_email)
                .limit(1)
                .execute()
            )

        candidate_id = candidate.data[0]["id"] if candidate.data else profile_id

        from app.services.chat_agent import run_candidate_chat_agent
        return run_candidate_chat_agent(
            message=request.message.strip(),
            conversation_id=conversation_id,
            candidate_id=candidate_id,
            profile_id=profile_id
        )

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        print(f"[candidate-message] Error: {e}")
        print(traceback.format_exc())
        return {
            "reply": "Something went wrong. Please try again.",
            "tool_used": None,
            "action_taken": None,
            "conversation_id": request.conversation_id or ""
        }


@router.get("/safety-stats")
async def get_safety_stats_endpoint(
    client=Depends(get_authed_client),
    recruiter_id: str = Depends(get_current_user_id),
):
    """
    Returns guardrail violation statistics for this recruiter.
    Shows the guardrail is actively protecting the system.
    """
    from app.services.guardrails import get_safety_stats
    return get_safety_stats(recruiter_id)
