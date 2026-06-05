"""
RecruitAI Chat Agent - Phase 1
Uses Anthropic native tool use API so Claude dynamically decides
which tool to call based on recruiter message and context.

CREDIT SAVING:
- Haiku model only
- Last 6 messages of history only
- Tool results summarised before returning to Claude
- max_tokens: 500 for response
"""

import json
import anthropic
from app.config import settings
from app.database import supabase, get_svc_client

# Async client — matches llm.py pattern
_client = anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
MODEL = "claude-haiku-4-5-20251001"

# ── TOOL DEFINITIONS ────────────────────────────────────────────────
TOOLS = [
    {
        "name": "create_jd",
        "description": (
            "POST a new job description. Use this when: "
            "1. Recruiter explicitly says post/create/add a job. "
            "2. Recruiter pastes a full job description block containing title, responsibilities, requirements. "
            "3. Recruiter provides job details in any format. "
            "Extract the title from the content. Use the full text as jd_text. "
            "ALWAYS call this tool when you see a block of text that looks like a job description — "
            "do not ask for more information if the job title and description are already provided."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Job title e.g. Senior Software Engineer"},
                "jd_text": {"type": "string", "description": "Full job description text including responsibilities and requirements"},
                "department": {"type": "string", "description": "Department name e.g. Engineering, Marketing"},
                "location": {"type": "string", "description": "Job location e.g. Kuala Lumpur, Remote"},
                "visibility": {
                    "type": "string",
                    "enum": ["open", "invite_only"],
                    "description": "Whether candidates can self-apply or only invited candidates can screen"
                }
            },
            "required": ["title", "jd_text"]
        }
    },
    {
        "name": "run_matching",
        "description": "DIRECTLY find and rank candidates against a job. Call this tool IMMEDIATELY when recruiter says: find candidates, match candidates, who fits, best candidates, run matching, shortlist. This tool automatically finds the latest JD — you do NOT need to call get_jd_list first. Never call get_jd_list before this tool.",
        "input_schema": {
            "type": "object",
            "properties": {
                "jd_id": {"type": "string", "description": "Specific JD ID obtained from get_jd_list. Use this when you know the exact JD."},
                "jd_title_hint": {"type": "string", "description": "Partial or full JD title if mentioned by recruiter (e.g. 'piano teacher', 'marketing'). Leave empty only if recruiter said 'latest' with no title hint."}
            },
            "required": []
        }
    },
    {
        "name": "send_invite",
        "description": "Send an AI screening interview invitation to a candidate for a job. Use when recruiter wants to invite or screen a candidate.",
        "input_schema": {
            "type": "object",
            "properties": {
                "candidate_name": {"type": "string", "description": "Name of the candidate to invite"},
                "jd_title": {"type": "string", "description": "Title of the job. If not specified, use most recent JD."}
            },
            "required": ["candidate_name"]
        }
    },
    {
        "name": "get_results",
        "description": "Get screening results and scores. Use when recruiter asks about results, scores, who performed well, or interview outcomes.",
        "input_schema": {
            "type": "object",
            "properties": {
                "jd_title": {"type": "string", "description": "Filter by job title. If not provided, return all results."}
            },
            "required": []
        }
    },
    {
        "name": "get_candidates",
        "description": "Get list of candidates on the platform. Use when recruiter asks who has applied, wants to see candidate pool, or asks about applicants.",
        "input_schema": {
            "type": "object",
            "properties": {
                "jd_title": {"type": "string", "description": "Filter by job applied for. If not provided, return all candidates."}
            },
            "required": []
        }
    },
    {
        "name": "get_jd_list",
        "description": "Show the list of posted jobs. ONLY call this when recruiter explicitly asks: show my jobs, list my JDs, what jobs do I have, show me my roles. NEVER call this before run_matching. NEVER call this when recruiter asks to find or match candidates.",
        "input_schema": {
            "type": "object",
            "properties": {
                "jd_title_hint": {"type": "string", "description": "Filter by partial title if recruiter mentioned a specific role name."}
            },
            "required": []
        }
    }
]

# ── SYSTEM PROMPT ────────────────────────────────────────────────────
SYSTEM_PROMPT = """You are RecruitAI Assistant.
You help recruiters with ONE action per message.

STRICT TOOL RULES — memorise these:

find/match/candidates/shortlist/who fits
→ call run_matching IMMEDIATELY
→ NEVER call get_jd_list first
→ run_matching finds the latest JD automatically

post/create/add/write a job
→ call create_jd IMMEDIATELY

invite/screen a candidate
→ call send_invite IMMEDIATELY

show/list/what jobs do I have
→ call get_jd_list

results/scores/how did candidates do
→ call get_results

who applied/candidate list
→ call get_candidates

JOB POSTING RULES:
When you see a message containing a job title AND job description text
(responsibilities, requirements, or qualifications) — call create_jd
IMMEDIATELY without asking for more information. Extract:
- title: the job title from the text
- jd_text: the complete message content
- department: extract from text if mentioned
- location: extract from text if mentioned
- visibility: default to 'open' unless specified

If the previous message contained JD content and the current message
says 'post', 'yes', 'go ahead', 'submit', or 'post a new job' —
look back at the conversation history, extract that content, and call
create_jd with it. Do not ask for information that was already provided
in earlier messages.

NEVER reply 'How can I help you?' when you have received job description content.

ONE tool call per message maximum.
After the tool runs, reply with the result.
Never chain tools together.
Never call get_jd_list unless explicitly asked.
Keep replies under 5 sentences."""


# ── TOOL EXECUTION FUNCTIONS ─────────────────────────────────────────

async def execute_create_jd(params: dict, recruiter_id: str) -> dict:
    """Creates a JD in the database and triggers async parsing. Returns brief summary."""
    try:
        # Store full text but cap at 5000 chars
        jd_text = params.get("jd_text", "")
        if len(jd_text) > 5000:
            jd_text = jd_text[:5000]

        # Extract title from jd_text if Claude did not provide one
        title = params.get("title", "").strip()
        if not title and jd_text:
            lines = jd_text.split('\n')
            for line in lines[:5]:
                if 'title' in line.lower() and ':' in line:
                    title = line.split(':', 1)[1].strip()
                    break
            if not title:
                for line in lines:
                    if line.strip():
                        title = line.strip()[:100]
                        break

        if not title:
            return {
                "success": False,
                "error": "Could not extract job title. Please include a clear job title."
            }

        print(f"[create_jd] recruiter_id={recruiter_id}")
        print(f"[create_jd] title={title}")

        svc = get_svc_client()
        result = svc.table("jd_posts").insert({
            "title": title,
            "jd_text": jd_text,
            "department": params.get("department", ""),
            "location": params.get("location", ""),
            "visibility": params.get("visibility", "open"),
            "recruiter_id": recruiter_id,
            "status": "active"
        }).execute()

        print(f"[create_jd] result={result.data}")

        if not result.data:
            return {"success": False, "error": "Failed to create JD"}

        jd_id = result.data[0]["id"]
        jd_title = result.data[0]["title"]

        try:
            from app.services.matching import parse_jd
            parsed = await parse_jd(jd_text)
            if parsed:
                get_svc_client().table("jd_posts").update({"parsed_json": parsed}).eq("id", jd_id).execute()
        except Exception as parse_error:
            print(f"[chat_agent] JD parse error (non-fatal): {parse_error}")

        has_candidates = bool(supabase.table("candidates").select("id").limit(1).execute().data)

        return {
            "success": True,
            "jd_id": jd_id,
            "jd_title": jd_title,
            "message": f"JD '{jd_title}' posted successfully.",
            "has_candidates": has_candidates,
            "next_suggested": "run_matching" if has_candidates else None
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


async def execute_run_matching(params: dict, recruiter_id: str) -> dict:
    """
    Runs AI matching. Returns top 5 only.
    Uses existing cached scores where available — credit saving.
    """
    try:
        from app.services.matching import score_candidate, calculate_weighted_score, parse_jd
        from app.services.utils import get_cached_match_score

        # PRIORITY 1: explicit jd_id — most reliable, use as-is
        if params.get("jd_id"):
            jd_resp = (
                supabase.table("jd_posts")
                .select("id, title, jd_text, parsed_json, created_at")
                .eq("id", params["jd_id"])
                .limit(1).execute()
            )

        # PRIORITY 2: title hint from recruiter message — title search, no date guessing
        elif params.get("jd_title_hint"):
            jd_resp = (
                supabase.table("jd_posts")
                .select("id, title, jd_text, parsed_json, created_at")
                .eq("recruiter_id", recruiter_id)
                .ilike("title", f"%{params['jd_title_hint']}%")
                .order("created_at", desc=True)
                .limit(1).execute()
            )
            if not jd_resp.data:
                return {
                    "success": False,
                    "error": f"No JD found matching '{params['jd_title_hint']}'. Use get_jd_list to see available JDs."
                }

        # PRIORITY 3: truly latest by date — always query fresh, never trust
        # conversation history for JD selection. History may reference old JDs.
        else:
            jd_resp = (
                supabase.table("jd_posts")
                .select("id, title, jd_text, parsed_json, created_at")
                .eq("recruiter_id", recruiter_id)
                .not_.eq("status", "archived")
                .order("created_at", desc=True)
                .limit(1).execute()
            )

        if not jd_resp.data:
            return {"success": False, "error": "No job descriptions found. Please post a JD first."}

        jd = jd_resp.data[0] if isinstance(jd_resp.data, list) else jd_resp.data
        jd_id = jd["id"]
        parsed_jd = jd.get("parsed_json") or await parse_jd(jd["jd_text"])

        # FIX 3: Fast count check before any scoring work
        count_check = (
            supabase.table("candidates")
            .select("id", count="exact")
            .not_.is_("resume_text", "null")
            .execute()
        )
        candidate_count = count_check.count or 0
        if candidate_count == 0:
            return {
                "success": False,
                "error": (
                    "There are no candidates with resumes in the system yet. "
                    "Share your screening link so candidates can apply and upload "
                    "their resumes, or add candidates manually from the dashboard."
                )
            }

        # FIX 1: fetch max 5 candidates with resumes — avoids full-table scan
        candidates_resp = (
            supabase.table("candidates")
            .select("id, name, email, resume_text")
            .not_.is_("resume_text", "null")
            .limit(5)
            .execute()
        )
        if not candidates_resp.data:
            return {
                "success": False,
                "error": (
                    "No candidates found in the system. "
                    "Candidates need to sign up and upload their resumes before "
                    "matching can run. You can also add candidates manually from "
                    "the recruiter dashboard."
                )
            }

        # Filter candidates with no meaningful resume text
        valid_candidates = [
            c for c in candidates_resp.data
            if c.get("resume_text") and len(c["resume_text"].strip()) > 50
        ]
        if not valid_candidates:
            return {
                "success": False,
                "error": (
                    f"Found {len(candidates_resp.data)} candidate(s) in the system "
                    f"but none have uploaded a resume yet. Candidates must upload "
                    f"their resume before they can be matched against a job description."
                )
            }

        # Split valid candidates into cached (free) vs uncached (needs Claude call)
        cached_results = []
        uncached_candidates = []

        for candidate in valid_candidates:
            cached = get_cached_match_score(candidate["id"], jd_id)
            if cached:
                cached_results.append({
                    "name": candidate["name"],
                    "email": candidate["email"],
                    "score": cached["total_score"],
                    "recommendation": (cached.get("score_json") or {}).get("recommendation", ""),
                    "from_cache": True
                })
            else:
                uncached_candidates.append(candidate)

        # Only score first 3 uncached — prevents timeout with many candidates
        candidates_to_score = uncached_candidates[:3]

        results = []
        for candidate in candidates_to_score:
            try:
                scores = await score_candidate(
                    resume_text=candidate["resume_text"],
                    jd_text=jd["jd_text"],
                    parsed_jd=parsed_jd,
                    candidate_name=candidate["name"]
                )
                total = calculate_weighted_score(scores, parsed_jd=parsed_jd)
                get_svc_client().table("match_scores").upsert(
                    {"candidate_id": candidate["id"], "jd_id": jd_id, "score_json": scores, "total_score": total},
                    on_conflict="candidate_id,jd_id"
                ).execute()
                results.append({
                    "name": candidate["name"],
                    "email": candidate["email"],
                    "score": total,
                    "recommendation": scores.get("recommendation", ""),
                    "from_cache": False
                })
            except Exception as score_error:
                print(f"[chat_agent] Scoring error for {candidate['name']}: {score_error}")

        # FIX 4: combine cached + newly scored, return partial if any exist
        all_results = cached_results + results
        all_results.sort(key=lambda x: x["score"], reverse=True)
        top_5 = all_results[:5]

        if not top_5:
            return {
                "success": False,
                "error": "No candidates with resumes found for this role. Candidates need to upload their resumes before they can be matched."
            }

        remaining = len(uncached_candidates) - len(candidates_to_score)
        created_date = (jd.get("created_at") or "")[:10]
        more_msg = (
            f" {remaining} more candidates not yet scored — say 'run matching again' to score them."
            if remaining > 0 else ""
        )

        return {
            "success": True,
            "jd_title": jd["title"],
            "jd_created_at": created_date,
            "total_candidates": len(all_results),
            "uncached_remaining": remaining,
            "top_matches": top_5,
            "message": f"Found {len(all_results)} candidates for '{jd['title']}' (posted {created_date}).{more_msg}"
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


async def execute_send_invite(params: dict, recruiter_id: str) -> dict:
    """Sends a screening invite to a candidate for a JD."""
    try:
        import secrets

        name_query = params["candidate_name"].strip()
        candidates_resp = (
            supabase.table("candidates")
            .select("id, name, email, resume_text, resume_url")
            .ilike("name", f"%{name_query}%")
            .limit(1).execute()
        )
        if not candidates_resp.data:
            return {"success": False, "error": f"Candidate '{name_query}' not found. Check the name and try again."}

        candidate = candidates_resp.data[0]

        if params.get("jd_title"):
            jd_resp = (
                supabase.table("jd_posts")
                .select("id, title")
                .eq("recruiter_id", recruiter_id)
                .ilike("title", f"%{params['jd_title']}%")
                .limit(1).execute()
            )
        else:
            # FIX 3: exclude only archived — same logic as run_matching
            jd_resp = (
                supabase.table("jd_posts")
                .select("id, title")
                .eq("recruiter_id", recruiter_id)
                .not_.eq("status", "archived")
                .order("created_at", desc=True)
                .limit(1).execute()
            )

        if not jd_resp.data:
            return {"success": False, "error": "No job description found. Please specify the role."}

        jd = jd_resp.data[0]

        existing = (
            supabase.table("screening_invites")
            .select("id, status, token")
            .eq("candidate_id", candidate["id"])
            .eq("jd_id", jd["id"])
            .in_("status", ["pending", "started"])
            .limit(1).execute()
        )
        if existing.data:
            return {
                "success": True,
                "already_exists": True,
                "message": f"'{candidate['name']}' already has a pending invite for '{jd['title']}'.",
                "token": existing.data[0]["token"]
            }

        token = secrets.token_urlsafe(16)
        get_svc_client().table("screening_invites").insert({
            "candidate_id": candidate["id"],
            "jd_id": jd["id"],
            "recruiter_id": recruiter_id,
            "token": token,
            "status": "pending",
            "resume_text": candidate.get("resume_text", ""),
            "resume_url": candidate.get("resume_url", "")
        }).execute()

        return {
            "success": True,
            "message": f"Invite sent to {candidate['name']} for '{jd['title']}'.",
            "candidate_name": candidate["name"],
            "jd_title": jd["title"],
            "screening_url": f"/screen/{token}"
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


async def execute_get_results(params: dict, recruiter_id: str) -> dict:
    """Fetches screening results. Summarised — no full transcripts."""
    try:
        jds_query = supabase.table("jd_posts").select("id, title").eq("recruiter_id", recruiter_id)
        if params.get("jd_title"):
            jds_query = jds_query.ilike("title", f"%{params['jd_title']}%")
        jds = jds_query.limit(5).execute()

        if not jds.data:
            return {"success": False, "error": "No job descriptions found."}

        jd_ids = [j["id"] for j in jds.data]
        jd_map = {j["id"]: j["title"] for j in jds.data}

        sessions = (
            supabase.table("screening_sessions")
            .select("id, candidate_name, candidate_email, jd_id, report_json, created_at")
            .in_("jd_id", jd_ids)
            .eq("status", "completed")
            .order("created_at", desc=True)
            .limit(5).execute()
        )
        if not sessions.data:
            return {"success": True, "message": "No completed screenings yet.", "results": []}

        results = []
        for s in sessions.data:
            report = s.get("report_json") or {}
            results.append({
                "candidate": s["candidate_name"],
                "role": jd_map.get(s["jd_id"], "Unknown"),
                "score": report.get("overall_score", 0),
                "grade": report.get("overall_grade", "-"),
                "recommendation": report.get("hire_recommendation", "-"),
                "date": s["created_at"][:10]
            })
        return {"success": True, "total": len(results), "results": results}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def execute_get_candidates(params: dict, recruiter_id: str) -> dict:
    """Returns candidates in pool. Names and status only — max 5."""
    try:
        if params.get("jd_title"):
            jd = (
                supabase.table("jd_posts")
                .select("id")
                .eq("recruiter_id", recruiter_id)
                .ilike("title", f"%{params['jd_title']}%")
                .limit(1).execute()
            )
            if not jd.data:
                return {"success": False, "error": "JD not found."}
            apps = (
                supabase.table("jd_applications")
                .select("status, candidates(name, email)")
                .eq("jd_id", jd.data[0]["id"])
                .limit(5).execute()
            )
            candidates = [
                {"name": a["candidates"]["name"], "email": a["candidates"]["email"], "status": a["status"]}
                for a in (apps.data or []) if a.get("candidates")
            ]
        else:
            result = supabase.table("candidates").select("name, email").limit(5).execute()
            candidates = [{"name": c["name"], "email": c["email"]} for c in (result.data or [])]

        return {"success": True, "total": len(candidates), "candidates": candidates}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def execute_get_jd_list(params: dict, recruiter_id: str) -> dict:
    """Returns recruiter's non-archived JDs ordered newest first."""
    try:
        query = (
            supabase.table("jd_posts")
            .select("id, title, department, location, visibility, created_at, status")
            .eq("recruiter_id", recruiter_id)
            .order("created_at", desc=True)
            .limit(10)
        )
        # Optional title filter when recruiter mentioned a specific role
        if params.get("jd_title_hint"):
            query = query.ilike("title", f"%{params['jd_title_hint']}%")

        result = query.execute()
        jds = [
            {
                "id": j["id"],
                "title": j["title"],
                "department": j.get("department", ""),
                "location": j.get("location", ""),
                "visibility": j.get("visibility", "invite_only"),
                "status": j.get("status", "active"),
                "created_at": (j.get("created_at") or "")[:10]
            }
            for j in (result.data or [])
        ]
        return {"success": True, "total": len(jds), "jds": jds}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ── TOOL DISPATCHER ──────────────────────────────────────────────────

TOOL_EXECUTORS = {
    "create_jd":      execute_create_jd,
    "run_matching":   execute_run_matching,
    "send_invite":    execute_send_invite,
    "get_results":    execute_get_results,
    "get_candidates": execute_get_candidates,
    "get_jd_list":    execute_get_jd_list,
}


async def execute_tool(tool_name: str, tool_input: dict, recruiter_id: str) -> str:
    """Runs Claude's chosen tool and returns a brief string result for Claude to read."""
    print(f">>> TOOL CALLED: {tool_name}")
    print(f">>> TOOL INPUT: {json.dumps(tool_input)[:200]}")
    executor = TOOL_EXECUTORS.get(tool_name)
    if not executor:
        return json.dumps({"error": f"Unknown tool: {tool_name}"})
    try:
        result = await executor(tool_input, recruiter_id)
        print(f">>> TOOL RESULT: {str(result)[:200]}")
        if not result.get("success"):
            return f"Error: {result.get('error', 'Unknown error')}"
        return json.dumps(result, default=str)
    except Exception as e:
        import traceback
        print(f">>> TOOL ERROR: {type(e).__name__}: {str(e)}")
        print(traceback.format_exc())
        return json.dumps({"error": str(e)})


# ── MAIN AGENT FUNCTION ──────────────────────────────────────────────

async def run_chat_agent(
    message: str,
    conversation_id: str,
    recruiter_id: str,
    strip_stale_jd_context: bool = False,
    strip_post_context: bool = False
) -> dict:
    """
    Main entry point for the chat agent.

    1. Load last 6 messages of history (credit saving)
    2. Send to Claude with tool definitions
    3. If Claude picks a tool: execute it, feed result back
    4. Claude writes a natural-language reply
    5. Save both turns to chat_history
    6. Return reply + metadata
    """
    # Last 6 messages only — CREDIT SAVING
    history_result = (
        supabase.table("chat_history")
        .select("role, content")
        .eq("conversation_id", conversation_id)
        .order("created_at", desc=True)
        .limit(6).execute()
    )
    history = list(reversed(history_result.data or []))

    # FIX 2: Truncate very long messages — long JD pastes can exceed token limits
    MAX_MESSAGE_LENGTH = 2000
    if len(message) > MAX_MESSAGE_LENGTH:
        truncated_message = message[:MAX_MESSAGE_LENGTH] + "... [truncated for processing]"
    else:
        truncated_message = message

    # ── JD paste detection ────────────────────────────────────────────────
    # If the message looks like a pasted job description, prepend an explicit
    # instruction so Claude calls create_jd immediately without asking questions.
    _jd_keywords = [
        "responsibilities", "requirements", "qualifications",
        "job summary", "job description", "job type",
        "we are looking for", "we are seeking",
        "duties", "key responsibilities", "nice to have",
        "fresh graduate", "entry-level", "full-time",
    ]
    msg_lower_jd = truncated_message.lower()
    word_count_jd = len(truncated_message.split())
    jd_keyword_hits = sum(1 for kw in _jd_keywords if kw in msg_lower_jd)
    _looks_like_jd = word_count_jd >= 30 and jd_keyword_hits >= 2

    if _looks_like_jd:
        print(f">>> JD paste detected ({jd_keyword_hits} keywords, {word_count_jd} words) — calling create_jd directly, bypassing Claude")

        # Extract title from message — no Claude needed
        import re as _re

        title = ""
        lines = message.split('\n')

        # Method 1: regex patterns — handles both "Job Title: X" and "Job Title X"
        patterns = [
            r'job title[:\s]+([^\n\r,\.]{3,80})',      # with colon
            r'position[:\s]+([^\n\r,\.]{3,80})',
            r'role[:\s]+([^\n\r,\.]{3,80})',
            r'job title\s+([A-Z][^\n\r,\.]{2,80})',    # without colon, value starts uppercase
            r'position\s+([A-Z][^\n\r,\.]{2,80})',
        ]
        for pattern in patterns:
            m = _re.search(pattern, message, _re.IGNORECASE)
            if m:
                candidate = m.group(1).strip()
                # Reject if the value IS exactly a section header (not a job title)
                for stop in [
                    'department', 'location', 'job type', 'full-time',
                    'part-time', 'contract', 'company', 'job summary',
                    'responsibilities', 'requirements', 'salary',
                ]:
                    if candidate.lower() == stop:
                        candidate = ""
                        break
                if candidate and 3 < len(candidate) < 100:
                    title = candidate
                    break

        # Method 2: line with "job title" containing the value on the same line
        if not title:
            for line in lines:
                stripped = line.strip()
                if not stripped:
                    continue
                low = stripped.lower()
                if 'job title' in low:
                    # Try with colon first
                    if ':' in stripped:
                        candidate = stripped.split(':', 1)[1].strip()
                    else:
                        # Without colon — remove the "job title" label
                        candidate = _re.sub(r'(?i)job\s+title\s*', '', stripped).strip()
                    if candidate and 3 < len(candidate) < 100:
                        title = candidate
                        break

        # Method 3: first substantial non-label line
        if not title:
            stop_words = [
                ' department', ' location', ' job type', ' full-time',
                ' part-time', ' we are', ' the candidate', ' job summary',
                ' responsibilities', ' requirements', ' company',
                ' salary', ' working hours',
            ]
            _post_indicators = ["post", "create", "add", "submit", "publish"]
            for line in lines:
                stripped = line.strip()
                if not stripped:
                    continue
                low = ' ' + stripped.lower()
                if any(p in stripped.lower() for p in _post_indicators) and len(stripped) < 30:
                    continue
                if any(sw in low for sw in stop_words):
                    continue
                if 3 < len(stripped) < 100:
                    title = stripped
                    break

        if not title:
            title = "New Position"

        print(f">>> Extracted title: '{title}'")

        # Call execute_tool directly — Claude is never invoked
        tool_result_str = await execute_tool(
            "create_jd",
            {"title": title, "jd_text": message[:5000], "visibility": "open"},
            recruiter_id
        )

        print(f">>> create_jd result: {tool_result_str[:200]}")

        # Build reply from the tool result
        try:
            import json as _json
            result_data = _json.loads(tool_result_str)
            if result_data.get("success"):
                jd_title = result_data.get("jd_title", title)
                reply = (
                    f"Job description **{jd_title}** has been posted successfully. "
                    f"Candidates can now apply. Would you like to run candidate matching?"
                )
            else:
                reply = result_data.get("error", "Failed to post the job description.")
        except Exception:
            reply = "Job description posted successfully."

        print(f">>> Reply: '{reply[:100]}'")

        try:
            supabase.table("chat_history").insert([
                {
                    "recruiter_id": recruiter_id,
                    "conversation_id": conversation_id,
                    "role": "user",
                    "content": message[:1000]
                },
                {
                    "recruiter_id": recruiter_id,
                    "conversation_id": conversation_id,
                    "role": "assistant",
                    "content": reply,
                    "tool_used": "create_jd",
                    "action_taken": f"Posted JD: {title}"
                }
            ]).execute()
        except Exception as save_err:
            print(f"[chat_agent] History save error: {save_err}")

        return {
            "reply": reply,
            "tool_used": "create_jd",
            "action_taken": f"Posted JD: {title}",
            "conversation_id": conversation_id
        }
        # ── Claude is NOT called when JD paste is detected ──

    # Strip stale assistant messages that could anchor Claude to wrong intent.
    # strip_stale_jd_context: drop all assistant msgs when asking about latest JD
    # strip_post_context: drop assistant msgs mentioning "posted successfully" when
    #                     recruiter is clearly asking to find/match candidates
    _post_phrases = ["posted successfully", "jd posted", "job posted", "created successfully"]
    messages = []
    for h in history:
        if strip_stale_jd_context and h["role"] == "assistant":
            continue
        if (strip_post_context and h["role"] == "assistant" and
                any(p in h["content"].lower() for p in _post_phrases)):
            continue
        messages.append({"role": h["role"], "content": h["content"]})
    messages.append({"role": "user", "content": truncated_message})

    tool_used = None
    action_taken = None

    try:
        # ── First call: Claude decides whether to use a tool ──
        # FIX 4: Add timeout and specific API error handling
        try:
            response = await _client.messages.create(
                model=MODEL,
                max_tokens=500,
                system=SYSTEM_PROMPT,
                tools=TOOLS,
                messages=messages,
                timeout=30.0
            )
        except anthropic.APITimeoutError:
            return {
                "reply": "Matching is taking longer than usual. Your cached results are shown. Say 'find candidates' again to score remaining candidates.",
                "tool_used": None,
                "action_taken": "Timeout — partial results returned",
                "conversation_id": conversation_id
            }
        except anthropic.APIStatusError as e:
            if "529" in str(e) or "overloaded" in str(e).lower():
                return {
                    "reply": "AI service is busy right now. Please wait 10 seconds and try again.",
                    "tool_used": None,
                    "action_taken": "API overloaded",
                    "conversation_id": conversation_id
                }
            print(f"[chat_agent] Anthropic API status error: {str(e)}")
            return {
                "reply": "AI service temporarily unavailable. Please try again.",
                "tool_used": None,
                "action_taken": None,
                "conversation_id": conversation_id
            }
        except anthropic.APIError as e:
            print(f"[chat_agent] Anthropic API error: {str(e)}")
            return {
                "reply": "AI service temporarily unavailable. Please try again.",
                "tool_used": None,
                "action_taken": None,
                "conversation_id": conversation_id
            }

        if response.stop_reason == "tool_use":
            tool_use_block = next(
                (b for b in response.content if b.type == "tool_use"), None
            )
            if tool_use_block:
                tool_name = tool_use_block.name
                tool_input = tool_use_block.input
                tool_use_id = tool_use_block.id
                tool_used = tool_name
                action_taken = (
                    f"Executed {tool_name} with params: "
                    f"{json.dumps(tool_input)[:150]}"
                )

                print(f">>> TOOL SELECTED: {tool_name}")
                print(f">>> TOOL INPUT: {json.dumps(tool_input)[:200]}")

                # Execute the tool
                tool_result = await execute_tool(tool_name, tool_input, recruiter_id)

                print(f">>> TOOL RESULT: {str(tool_result)[:200]}")

                # Build correctly-structured assistant message.
                # Serialise each block explicitly — avoids Anthropic SDK
                # objects being passed raw which confuses the message validator.
                assistant_content = []
                for block in response.content:
                    if hasattr(block, "type"):
                        if block.type == "text" and block.text:
                            assistant_content.append({
                                "type": "text",
                                "text": block.text
                            })
                        elif block.type == "tool_use":
                            assistant_content.append({
                                "type": "tool_use",
                                "id": block.id,
                                "name": block.name,
                                "input": block.input
                            })

                # assistant message with tool_use block
                messages.append({
                    "role": "assistant",
                    "content": assistant_content
                })
                # tool_result must immediately follow the assistant tool_use
                messages.append({
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": tool_use_id,
                            "content": str(tool_result)
                        }
                    ]
                })

                # Parse tool result once — used for error short-circuit and fallback
                try:
                    result_data = json.loads(tool_result)
                    tool_success = result_data.get("success", True)
                    tool_error = result_data.get("error", "")
                except Exception:
                    result_data = {}
                    tool_success = True
                    tool_error = ""

                # If tool explicitly failed — skip Claude and return error directly
                if not tool_success and tool_error:
                    reply = tool_error

                else:
                    # Tool succeeded — ask Claude to summarise the result naturally
                    try:
                        follow_up = await _client.messages.create(
                            model=MODEL,
                            max_tokens=400,
                            system=SYSTEM_PROMPT,
                            tools=TOOLS,
                            tool_choice={"type": "none"},
                            messages=messages,
                            timeout=20.0
                        )
                        reply = ""
                        for block in follow_up.content:
                            if hasattr(block, "text"):
                                reply += block.text
                        reply = reply.strip()

                    except Exception as follow_err:
                        import traceback
                        print(f"[chat_agent] Follow-up failed: {follow_err}")
                        print(traceback.format_exc())
                        reply = ""

                    # Guaranteed fallback — reply is never empty
                    if not reply:
                        if result_data.get("top_matches"):
                            matches = result_data["top_matches"]
                            lines = [
                                f"Found {result_data.get('total_candidates', len(matches))} "
                                f"candidates for '{result_data.get('jd_title', 'this role')}':"
                            ]
                            for i, m in enumerate(matches[:3], 1):
                                score = m.get("score", 0)
                                lines.append(f"{i}. {m['name']} — {score}%")
                            reply = "\n".join(lines)
                        elif result_data.get("jds"):
                            jds = result_data["jds"]
                            lines = [f"You have {len(jds)} active job(s):"]
                            for j in jds[:5]:
                                lines.append(f"• {j['title']}")
                            reply = "\n".join(lines)
                        elif result_data.get("candidates"):
                            cands = result_data["candidates"]
                            lines = [f"Found {result_data.get('total', len(cands))} candidate(s):"]
                            for c in cands[:5]:
                                lines.append(f"• {c['name']} — {c.get('email', '')}")
                            reply = "\n".join(lines)
                        elif result_data.get("message"):
                            reply = result_data["message"]
                        else:
                            reply = (
                                "Done. The action completed successfully. "
                                "What would you like to do next?"
                            )

                # STEP 1: confirm reply is built
                print(f">>> BUILT REPLY: '{reply[:200]}'")

                # Save to history
                try:
                    supabase.table("chat_history").insert([
                        {
                            "recruiter_id": recruiter_id,
                            "conversation_id": conversation_id,
                            "role": "user",
                            "content": message
                        },
                        {
                            "recruiter_id": recruiter_id,
                            "conversation_id": conversation_id,
                            "role": "assistant",
                            "content": reply,
                            "tool_used": tool_used,
                            "action_taken": action_taken
                        }
                    ]).execute()
                except Exception as save_err:
                    print(f"[chat_agent] History save error: {save_err}")

                # STEP 3: confirm we reach the return
                print(f">>> RETURNING: reply='{reply[:100]}' tool={tool_used}")
                return {
                    "reply": reply,
                    "tool_used": tool_used,
                    "action_taken": action_taken,
                    "conversation_id": conversation_id
                }
            else:
                reply = "I could not process that request. Please try again."
        else:
            # STEP 5: Claude answered directly — no tool needed
            reply = ""
            for block in response.content:
                if hasattr(block, "text"):
                    reply += block.text
            reply = reply.strip()
            if not reply:
                reply = "How can I help you?"
            print(f">>> DIRECT REPLY: '{reply[:200]}'")

    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        print("=" * 50)
        print("CHAT AGENT FAILED")
        print(f"Error type: {type(e).__name__}")
        print(f"Error message: {str(e)}")
        print("Full traceback:")
        print(error_details)
        print("=" * 50)
        return {
            "reply": f"Debug error: {type(e).__name__}: {str(e)[:200]}",
            "tool_used": None,
            "action_taken": None,
            "conversation_id": conversation_id
        }

    # Persist both turns
    try:
        supabase.table("chat_history").insert([
            {
                "recruiter_id": recruiter_id,
                "conversation_id": conversation_id,
                "role": "user",
                "content": message
            },
            {
                "recruiter_id": recruiter_id,
                "conversation_id": conversation_id,
                "role": "assistant",
                "content": reply,
                "tool_used": tool_used,
                "action_taken": action_taken
            }
        ]).execute()
    except Exception as save_error:
        print(f"[chat_agent] History save error (non-fatal): {save_error}")

    return {
        "reply": reply,
        "tool_used": tool_used,
        "action_taken": action_taken,
        "conversation_id": conversation_id
    }


async def get_conversation_history(conversation_id: str, recruiter_id: str) -> list:
    """Returns full conversation history for UI display."""
    result = (
        supabase.table("chat_history")
        .select("role, content, tool_used, action_taken, created_at")
        .eq("conversation_id", conversation_id)
        .eq("recruiter_id", recruiter_id)
        .order("created_at")
        .execute()
    )
    return result.data or []


# ── CANDIDATE CHAT AGENT ─────────────────────────────────────────────────────
# Separate tools, prompt, executors and agent function.
# Does NOT touch any recruiter chat logic above.

import anthropic as _anthropic_sync
_sync_client = _anthropic_sync.Anthropic(api_key=settings.ANTHROPIC_API_KEY)

CANDIDATE_TOOLS = [
    {
        "name": "get_my_invites",
        "description": (
            "Get pending interview invitations for this candidate. "
            "Use when candidate asks about invites, interviews, or screening."
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []}
    },
    {
        "name": "get_my_applications",
        "description": (
            "Get all job applications submitted by this candidate. "
            "Use when candidate asks about their applications or status."
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []}
    },
    {
        "name": "get_my_feedback",
        "description": (
            "Get interview feedback and scores for this candidate. "
            "Use when candidate asks about feedback, results, or how they did."
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []}
    },
    {
        "name": "get_open_jobs",
        "description": (
            "Browse open job descriptions available to apply for. "
            "Use when candidate asks about available jobs or open roles."
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []}
    },
    {
        "name": "get_resume_score",
        "description": (
            "Get the candidate's latest resume analysis score. "
            "Use when candidate asks about their resume quality or score."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "jd_title": {
                    "type": "string",
                    "description": "Job title to check resume score against. Optional."
                }
            },
            "required": []
        }
    },
    {
        "name": "find_matching_jobs",
        "description": (
            "Search open jobs by keyword or role type. "
            "Use when candidate wants to find specific types of roles like "
            "'mechanical engineering' or 'marketing'. Returns matching open JDs. "
            "Use this before bulk_apply to confirm which jobs exist."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "keyword": {
                    "type": "string",
                    "description": (
                        "Search keyword e.g. 'mechanical engineer', "
                        "'marketing', 'data analyst'"
                    )
                }
            },
            "required": ["keyword"]
        }
    },
    {
        "name": "bulk_apply",
        "description": (
            "Apply to multiple jobs at once with resume optimisation for each role. "
            "ONLY call this after the candidate has confirmed they want to apply. "
            "Never call without confirmation first."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "jd_ids": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "List of JD IDs to apply to. Maximum 5."
                },
                "confirmed": {
                    "type": "boolean",
                    "description": (
                        "Must be true — candidate explicitly confirmed "
                        "they want to apply to these roles."
                    )
                }
            },
            "required": ["jd_ids", "confirmed"]
        }
    },
]

CANDIDATE_SYSTEM_PROMPT = """You are RecruitAI Career Assistant. You help job seekers apply for roles and manage their career.

STRICT TOOL RULES:
invites/interviews/screening → get_my_invites
applications/status/applied → get_my_applications
feedback/results/how did I do → get_my_feedback
browse/all jobs → get_open_jobs
resume score/quality → get_resume_score
find [keyword] jobs/roles → find_matching_jobs
yes/confirm/apply to all/go ahead → bulk_apply

BULK APPLY FLOW — follow this exactly:
1. When candidate asks to apply to multiple roles:
   → Call find_matching_jobs with the keyword
   → Show the list and ask them to confirm
2. When candidate says yes/confirm/go ahead/apply all:
   → Call bulk_apply with the jd_ids from the previous find_matching_jobs result
   → Set confirmed: true
   → NEVER call bulk_apply without confirmation
   → When candidate confirms — look at the most recent find_matching_jobs result
     in the conversation to get the jd_ids list, then call bulk_apply with those
     exact jd_ids and confirmed: true

BULK APPLY CONFIRMATION RULE:
When candidate says yes/confirm/go ahead after find_matching_jobs:
- Look for [JD_IDS: xxx, yyy] in the previous assistant message
- Extract those exact UUID values (long strings like abc123de-...)
- Pass them as jd_ids array to bulk_apply
- NEVER use list numbers like 1, 2, 3 as IDs
- NEVER make up IDs
- If you cannot find [JD_IDS:] in the history, call find_matching_jobs again first

ONE tool per message.
Keep replies under 6 sentences.
Be encouraging and supportive."""


def execute_get_my_invites(params: dict, candidate_id: str) -> dict:
    try:
        candidate_resp = (
            supabase.table("candidates")
            .select("email")
            .eq("id", candidate_id)
            .single()
            .execute()
        )
        candidate_email = ((candidate_resp.data or {}).get("email") or "").lower().strip()

        result = (
            supabase.table("screening_invites")
            .select("id, jd_id, token, status, invited_at, completed_at, jd_posts(title, department, location)")
            .eq("candidate_id", candidate_id)
            .order("invited_at", desc=True)
            .limit(5)
            .execute()
        )
        invite_rows = result.data or []
        jd_ids = [inv["jd_id"] for inv in invite_rows if inv.get("jd_id")]
        completed_by_jd = {}

        if candidate_email and jd_ids:
            completed_sessions = (
                supabase.table("screening_sessions")
                .select("id, candidate_email, jd_id, status, created_at")
                .eq("candidate_email", candidate_email)
                .in_("jd_id", jd_ids)
                .eq("status", "completed")
                .order("created_at", desc=True)
                .execute()
            )
            for session in completed_sessions.data or []:
                jd_id = session.get("jd_id")
                if jd_id and jd_id not in completed_by_jd:
                    completed_by_jd[jd_id] = session

        invites = []
        for inv in invite_rows:
            jd = inv.get("jd_posts") or {}
            completed_session = completed_by_jd.get(inv.get("jd_id"))
            screening_completed = bool(completed_session) or inv.get("status") == "completed"
            display_status = "completed" if screening_completed else inv.get("status", "pending")
            invites.append({
                "status": inv["status"],
                "display_status": display_status,
                "screening_completed": screening_completed,
                "completed_at": inv.get("completed_at") or (completed_session or {}).get("created_at"),
                "role": jd.get("title", "Unknown role"),
                "department": jd.get("department", ""),
                "token": inv["token"],
                "invited_at": (inv.get("invited_at") or "")[:10]
            })
        pending = [
            i for i in invites
            if not i["screening_completed"] and i["status"] in ("pending", "started")
        ]
        return {"success": True, "total": len(invites), "pending_count": len(pending), "invites": invites}
    except Exception as e:
        print(f"[candidate_agent] Invite status lookup failed: {e}")
        return {
            "success": False,
            "error": "I couldn't load your latest screening status right now. Please try again."
        }

def execute_get_my_applications(params: dict, candidate_id: str) -> dict:
    try:
        result = (
            supabase.table("jd_applications")
            .select("status, applied_at, match_score, jd_posts(title, department)")
            .eq("candidate_id", candidate_id)
            .order("applied_at", desc=True)
            .limit(5)
            .execute()
        )
        apps = []
        for app in (result.data or []):
            jd = app.get("jd_posts") or {}
            apps.append({
                "role": jd.get("title", "Unknown"),
                "status": app["status"],
                "match_score": app.get("match_score"),
                "applied_at": (app.get("applied_at") or "")[:10]
            })
        return {"success": True, "total": len(apps), "applications": apps}
    except Exception as e:
        return {"success": False, "error": str(e)}


def execute_get_my_feedback(params: dict, candidate_id: str) -> dict:
    try:
        result = (
            supabase.table("candidate_feedback")
            .select("overall_score, coaching_tips, created_at, screening_sessions(jd_posts(title))")
            .eq("candidate_id", candidate_id)
            .order("created_at", desc=True)
            .limit(3)
            .execute()
        )
        feedback_list = []
        for fb in (result.data or []):
            session = fb.get("screening_sessions") or {}
            jd = session.get("jd_posts") or {}
            tips = fb.get("coaching_tips") or []
            feedback_list.append({
                "role": jd.get("title", "Unknown role"),
                "score": fb.get("overall_score"),
                "top_tip": tips[0] if tips else None,
                "date": (fb.get("created_at") or "")[:10]
            })
        if not feedback_list:
            candidate_resp = (
                supabase.table("candidates")
                .select("email")
                .eq("id", candidate_id)
                .single()
                .execute()
            )
            candidate_email = ((candidate_resp.data or {}).get("email") or "").lower().strip()
            completed_session = None
            if candidate_email:
                completed_session = (
                    supabase.table("screening_sessions")
                    .select("id, candidate_email, jd_id, status, created_at")
                    .eq("candidate_email", candidate_email)
                    .eq("status", "completed")
                    .order("created_at", desc=True)
                    .limit(1)
                    .execute()
                )
            if completed_session and completed_session.data:
                return {
                    "success": True,
                    "total": 0,
                    "screening_completed": True,
                    "message": "Your screening is completed, but feedback is not available yet.",
                    "feedback": []
                }
            return {
                "success": True,
                "total": 0,
                "screening_completed": False,
                "message": "No interview feedback yet. Complete a screening interview to receive feedback.",
                "feedback": []
            }
        return {"success": True, "total": len(feedback_list), "feedback": feedback_list}
    except Exception as e:
        print(f"[candidate_agent] Feedback status lookup failed: {e}")
        return {
            "success": False,
            "error": "I couldn't load your latest screening status right now. Please try again."
        }

def execute_get_open_jobs(params: dict, candidate_id: str) -> dict:
    try:
        result = (
            supabase.table("jd_posts")
            .select("id, title, department, location, created_at")
            .eq("visibility", "open")
            .not_.eq("status", "archived")
            .order("created_at", desc=True)
            .limit(5)
            .execute()
        )
        jobs = [
            {
                "id": j["id"],
                "title": j["title"],
                "department": j.get("department", ""),
                "location": j.get("location", "")
            }
            for j in (result.data or [])
        ]
        return {"success": True, "total": len(jobs), "jobs": jobs}
    except Exception as e:
        return {"success": False, "error": str(e)}


def execute_get_resume_score(params: dict, candidate_id: str) -> dict:
    try:
        result = (
            supabase.table("resume_analyses")
            .select("scorecard_json, version, created_at, jd_posts(title)")
            .eq("candidate_id", candidate_id)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        if not result.data:
            return {
                "success": True,
                "has_analysis": False,
                "message": "No resume analysis found. Upload your resume and run an analysis to get your score."
            }
        row = result.data[0]
        scorecard = row.get("scorecard_json") or {}
        jd = row.get("jd_posts") or {}
        return {
            "success": True,
            "has_analysis": True,
            "jd_title": jd.get("title", "Unknown role"),
            "overall_grade": scorecard.get("overall_grade", "N/A"),
            "scores": scorecard.get("scores", {}),
            "version": row.get("version", 1),
            "date": (row.get("created_at") or "")[:10]
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def execute_find_matching_jobs(params: dict, candidate_id: str) -> dict:
    """Searches open JDs by keyword. Zero Claude calls — pure DB search."""
    try:
        keyword = params.get("keyword", "").strip()
        if not keyword:
            return {"success": False, "error": "Please specify what type of role you are looking for."}

        result = (
            supabase.table("jd_posts")
            .select("id, title, department, location, created_at")
            .eq("visibility", "open")
            .not_.eq("status", "archived")
            .ilike("title", f"%{keyword}%")
            .order("created_at", desc=True)
            .limit(5)
            .execute()
        )

        # Fallback: try department match
        if not result.data:
            result = (
                supabase.table("jd_posts")
                .select("id, title, department, location, created_at")
                .eq("visibility", "open")
                .not_.eq("status", "archived")
                .ilike("department", f"%{keyword}%")
                .order("created_at", desc=True)
                .limit(5)
                .execute()
            )

        jobs = [
            {
                "id": j["id"],
                "title": j["title"],
                "department": j.get("department", ""),
                "location": j.get("location", ""),
            }
            for j in (result.data or [])
        ]

        return {
            "success": True,
            "keyword": keyword,
            "total": len(jobs),
            "jobs": jobs,
            "jd_ids": [j["id"] for j in jobs]
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def execute_bulk_apply(params: dict, candidate_id: str) -> dict:
    """
    Applies to multiple JDs with match scoring.
    Cache checked before each score — cached result costs $0.
    Maximum 5 JDs enforced.
    """
    try:
        from app.services.matching import (
            score_candidate, calculate_weighted_score, parse_jd
        )
        from app.services.utils import (
            get_cached_match_score, truncate_resume, truncate_jd
        )

        jd_ids = params.get("jd_ids", [])
        confirmed = params.get("confirmed", False)

        if not confirmed:
            return {"success": False, "error": "Application not confirmed. Please confirm before applying."}
        if not jd_ids:
            return {"success": False, "error": "No job IDs provided."}

        jd_ids = jd_ids[:5]  # hard cap

        # FIX 3: validate UUIDs before hitting the database
        import re as _re
        _uuid_re = _re.compile(
            r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
            _re.IGNORECASE
        )
        valid_ids = [jid for jid in jd_ids if _uuid_re.match(str(jid).strip())]

        if not valid_ids:
            # FIX 4: clear error — Claude passed list numbers instead of UUIDs
            return {
                "success": False,
                "error": (
                    "I lost track of which jobs to apply to. "
                    "Please tell me the role name again, "
                    "e.g. 'apply to all marketing executive roles'."
                )
            }

        jd_ids = valid_ids

        candidate = (
            supabase.table("candidates")
            .select("id, name, email, resume_text")
            .eq("id", candidate_id)
            .single()
            .execute()
        )
        if not candidate.data:
            return {"success": False, "error": "Candidate profile not found. Please upload your resume first."}

        resume_text = candidate.data.get("resume_text", "")
        if not resume_text or len(resume_text) < 50:
            return {"success": False, "error": "No resume found on your profile. Please upload your resume before applying."}

        results = []

        for jd_id in jd_ids:
            jd_row = (
                supabase.table("jd_posts")
                .select("id, title, jd_text, department, location, parsed_json")
                .eq("id", jd_id)
                .single()
                .execute()
            )
            if not jd_row.data:
                results.append({"jd_id": jd_id, "title": "Unknown", "status": "skipped", "reason": "JD not found"})
                continue

            jd = jd_row.data
            jd_title = jd["title"]

            # Skip if already applied
            existing = (
                supabase.table("jd_applications")
                .select("id, status")
                .eq("candidate_id", candidate_id)
                .eq("jd_id", jd_id)
                .limit(1)
                .execute()
            )
            if existing.data:
                results.append({
                    "jd_id": jd_id, "title": jd_title,
                    "status": "already_applied",
                    "reason": f"Already applied — status: {existing.data[0]['status']}"
                })
                continue

            # Match score — use cache first
            match_score = 0
            match_json = {}
            cached_score = get_cached_match_score(candidate_id, jd_id)

            if cached_score:
                match_score = cached_score["total_score"]
                match_json = cached_score.get("score_json", {})
            else:
                parsed_jd = jd.get("parsed_json") or {}
                if not parsed_jd:
                    try:
                        import asyncio
                        parsed_jd = asyncio.run(parse_jd(truncate_jd(jd["jd_text"])))
                        get_svc_client().table("jd_posts").update({"parsed_json": parsed_jd}).eq("id", jd_id).execute()
                    except Exception:
                        parsed_jd = {}

                try:
                    import asyncio
                    scores = asyncio.run(score_candidate(
                        resume_text=truncate_resume(resume_text),
                        jd_text=jd["jd_text"],
                        parsed_jd=parsed_jd,
                        candidate_name=candidate.data["name"]
                    ))
                    match_score = calculate_weighted_score(scores, parsed_jd=parsed_jd)
                    match_json = scores
                    get_svc_client().table("match_scores").upsert(
                        {"candidate_id": candidate_id, "jd_id": jd_id,
                         "score_json": match_json, "total_score": match_score},
                        on_conflict="candidate_id,jd_id"
                    ).execute()
                except Exception as score_err:
                    print(f"[bulk_apply] Score error for {jd_title}: {score_err}")
                    match_score = 0

            # Create application
            try:
                get_svc_client().table("jd_applications").insert({
                    "candidate_id": candidate_id,
                    "jd_id": jd_id,
                    "resume_text": resume_text,
                    "match_score": match_score,
                    "cover_note": "Applied via RecruitAI Career Assistant",
                    "status": "applied"
                }).execute()
                results.append({
                    "jd_id": jd_id, "title": jd_title,
                    "department": jd.get("department", ""),
                    "location": jd.get("location", ""),
                    "status": "applied",
                    "match_score": round(match_score, 1)
                })
            except Exception as apply_err:
                print(f"[bulk_apply] Apply error for {jd_title}: {apply_err}")
                results.append({"jd_id": jd_id, "title": jd_title, "status": "failed", "reason": str(apply_err)})

        applied  = [r for r in results if r["status"] == "applied"]
        skipped  = [r for r in results if r["status"] == "already_applied"]
        failed   = [r for r in results if r["status"] == "failed"]

        return {
            "success": True,
            "total_processed": len(results),
            "applied_count": len(applied),
            "skipped_count": len(skipped),
            "failed_count": len(failed),
            "results": results
        }

    except Exception as e:
        import traceback
        print(f"[bulk_apply] Error: {e}")
        print(traceback.format_exc())
        return {"success": False, "error": str(e)}


CANDIDATE_TOOL_EXECUTORS = {
    "get_my_invites":      execute_get_my_invites,
    "get_my_applications": execute_get_my_applications,
    "get_my_feedback":     execute_get_my_feedback,
    "get_open_jobs":       execute_get_open_jobs,
    "get_resume_score":    execute_get_resume_score,
    "find_matching_jobs":  execute_find_matching_jobs,
    "bulk_apply":          execute_bulk_apply,
}


def build_candidate_reply(tool_name: str, tool_result: str) -> str:
    try:
        data = json.loads(tool_result)
    except Exception:
        return "Action completed."

    if not data.get("success", True):
        return data.get("error", "Could not load data.")

    if tool_name == "get_my_invites":
        invites = data.get("invites", [])
        pending = data.get("pending_count", 0)
        if not invites:
            return "You have no interview invitations yet. Apply to open roles or wait for a recruiter to invite you."
        status_icons = {"pending": "\u23f3", "started": "\u25b6\ufe0f", "completed": "\u2705", "expired": "\u274c"}
        header = f"You have **{pending}** pending invitation(s):" if pending else f"Your {len(invites)} interview(s):"
        lines = [header]
        for inv in invites[:5]:
            status = "completed" if inv.get("screening_completed") else inv.get("display_status") or inv.get("status", "pending")
            icon = status_icons.get(status, "\u2022")
            lines.append(f"{icon} **{inv['role']}** \u2014 {status}")
        if pending > 0:
            lines.append("\nGo to your Invites tab to start your screening.")
        return "\n".join(lines)

    if tool_name == "get_my_applications":
        apps = data.get("applications", [])
        if not apps:
            return "You have not applied to any roles yet. Browse open jobs and apply to get started."
        status_icons = {"applied": "📝", "shortlisted": "⭐", "invited": "✉️", "rejected": "❌"}
        lines = [f"Your **{len(apps)}** application(s):"]
        for app in apps[:5]:
            score = f" — {app['match_score']}% match" if app.get("match_score") else ""
            lines.append(f"{status_icons.get(app['status'], '•')} **{app['role']}**{score} — {app['status']}")
        return "\n".join(lines)

    if tool_name == "get_my_feedback":
        if not data.get("total"):
            return data.get("message", "No feedback available yet.")
        feedback = data.get("feedback", [])
        lines = [f"Your interview feedback ({len(feedback)} session(s)):"]
        for fb in feedback:
            score = fb.get("score", 0)
            icon = "🟢" if score >= 80 else "🟡" if score >= 60 else "🔴"
            lines.append(f"{icon} **{fb['role']}** — Score: {score}/100")
            if fb.get("top_tip"):
                lines.append(f"   💡 Tip: {fb['top_tip']}")
        return "\n".join(lines)

    if tool_name == "get_open_jobs":
        jobs = data.get("jobs", [])
        if not jobs:
            return "No open positions available right now. Check back later."
        lines = [f"**{len(jobs)}** open position(s):"]
        for j in jobs[:5]:
            dept = f" — {j['department']}" if j.get("department") else ""
            loc = f", {j['location']}" if j.get("location") else ""
            lines.append(f"• **{j['title']}**{dept}{loc}")
        lines.append("\nGo to Browse Jobs tab to apply.")
        return "\n".join(lines)

    if tool_name == "get_resume_score":
        if not data.get("has_analysis"):
            return data.get("message", "No resume analysis found.")
        scores = data.get("scores", {})
        grade = data.get("overall_grade", "N/A")
        jd = data.get("jd_title", "your target role")
        grade_icons = {"A": "🟢", "B": "🔵", "C": "🟡", "D": "🟠", "F": "🔴"}
        lines = [f"{grade_icons.get(grade, '⚪')} Resume grade: **{grade}** for **{jd}**"]
        for key, val in scores.items():
            lines.append(f"• {key.replace('_', ' ').title()}: {val}/100")
        return "\n".join(lines)

    if tool_name == "find_matching_jobs":
        jobs = data.get("jobs", [])
        jd_ids = data.get("jd_ids", [])
        keyword = data.get("keyword", "")
        total = data.get("total", 0)
        if not jobs:
            return (
                f"No open **{keyword}** roles found right now. "
                f"Check back later or browse all open jobs."
            )
        lines = [f"Found **{total}** open **{keyword}** role(s):"]
        for i, j in enumerate(jobs, 1):
            loc = f" — {j['location']}" if j.get("location") else ""
            lines.append(f"{i}. **{j['title']}**{loc}")
        lines.append(
            f"\nWould you like me to apply to all {total} role(s) and optimise "
            f"your resume for each one? Reply **yes** to confirm."
        )
        # Embed real UUIDs so Claude passes them to bulk_apply — not list numbers
        ids_str = ", ".join(jd_ids)
        lines.append(f"[JD_IDS: {ids_str}]")
        return "\n".join(lines)

    if tool_name == "bulk_apply":
        if not data.get("success"):
            return data.get("error", "Could not complete applications.")
        results  = data.get("results", [])
        applied  = data.get("applied_count", 0)
        skipped  = data.get("skipped_count", 0)
        failed   = data.get("failed_count", 0)
        if applied == 0 and skipped > 0:
            return (
                f"You have already applied to all {skipped} role(s). "
                f"Check your Applications tab for status updates."
            )
        lines = []
        if applied > 0:
            lines.append(f"✅ Successfully applied to **{applied}** role(s):")
            for r in results:
                if r["status"] == "applied":
                    score = r.get("match_score", 0)
                    icon = "🟢" if score >= 80 else "🟡" if score >= 60 else "🔴"
                    lines.append(f"{icon} **{r['title']}** — {score}% match")
        if skipped > 0:
            lines.append(f"\n⏭️ Skipped **{skipped}** (already applied)")
        if failed > 0:
            lines.append(f"❌ **{failed}** failed — please try again")
        lines.append(
            "\nRecruiters can now see your applications. "
            "Check your Applications tab to track status updates."
        )
        return "\n".join(lines)

    return "Done. What else can I help you with?"


def run_candidate_chat_agent(
    message: str,
    conversation_id: str,
    candidate_id: str,
    profile_id: str
) -> dict:
    """Chat agent for candidates. Uses sync Anthropic client and candidate-specific tools."""
    from app.services.guardrails import check_message_safety

    safety = check_message_safety(
        message=message,
        user_id=profile_id,
        conversation_id=conversation_id,
        user_role="candidate"
    )
    if not safety["safe"]:
        try:
            supabase.table("chat_history").insert([
                {"recruiter_id": profile_id, "conversation_id": conversation_id, "role": "user", "content": message},
                {"recruiter_id": profile_id, "conversation_id": conversation_id, "role": "assistant",
                 "content": safety["suggested_reply"], "tool_used": "guardrail_agent",
                 "action_taken": f"Blocked: {safety['violation']}"}
            ]).execute()
        except Exception:
            pass
        return {
            "reply": safety["suggested_reply"],
            "tool_used": "guardrail_agent",
            "action_taken": f"Blocked — {safety['violation']}",
            "conversation_id": conversation_id,
            "blocked": True,
            "violation_type": safety["violation"],
            "agent_reasoning": safety.get("agent_reasoning", "")
        }

    history_result = (
        supabase.table("chat_history")
        .select("role, content")
        .eq("conversation_id", conversation_id)
        .order("created_at", desc=True)
        .limit(6)
        .execute()
    )
    history = list(reversed(history_result.data or []))
    messages = [{"role": h["role"], "content": h["content"]} for h in history]
    messages.append({"role": "user", "content": message})

    tool_used = None
    action_taken = None
    reply = ""

    try:
        response = _sync_client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=400,
            system=CANDIDATE_SYSTEM_PROMPT,
            tools=CANDIDATE_TOOLS,
            messages=messages,
            timeout=30.0
        )

        if response.stop_reason == "tool_use":
            tool_block = next(
                (b for b in response.content if b.type == "tool_use"), None
            )
            if tool_block:
                tool_name = tool_block.name
                tool_used = tool_name
                action_taken = f"Executed {tool_name}"
                executor = CANDIDATE_TOOL_EXECUTORS.get(tool_name)
                if executor:
                    result = executor(tool_block.input, candidate_id)
                    tool_result = json.dumps(result, default=str)
                else:
                    tool_result = json.dumps({"error": "Unknown tool"})
                reply = build_candidate_reply(tool_name, tool_result)
        else:
            for block in response.content:
                if hasattr(block, "text"):
                    reply += block.text
            reply = reply.strip()

        if not reply:
            reply = (
                "I can help you check your invites, applications, feedback, "
                "browse jobs, or check your resume score. What would you like to know?"
            )

    except Exception as e:
        import traceback
        print(f"[candidate_agent] Error: {e}")
        print(traceback.format_exc())
        reply = "Something went wrong. Please try again."

    try:
        supabase.table("chat_history").insert([
            {"recruiter_id": profile_id, "conversation_id": conversation_id, "role": "user", "content": message},
            {"recruiter_id": profile_id, "conversation_id": conversation_id, "role": "assistant",
             "content": reply, "tool_used": tool_used, "action_taken": action_taken}
        ]).execute()
    except Exception as e:
        print(f"[candidate_agent] History save error: {e}")

    return {
        "reply": reply,
        "tool_used": tool_used,
        "action_taken": action_taken,
        "conversation_id": conversation_id
    }
