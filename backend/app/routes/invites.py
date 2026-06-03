import secrets
from fastapi import APIRouter, Depends, HTTPException
from app.database import supabase, get_authed_client, get_current_user_id
from app.models.schemas import CreateInviteRequest

router = APIRouter(prefix="/invites", tags=["invites"])


def _question_payload(question: dict, index: int) -> dict:
    return {
        "id": question.get("id", index + 1),
        "question": (question.get("question") or "").strip(),
        "dimension": question.get("dimension") or "job_fit",
        "probes_skill": question.get("probes_skill") or "role fit",
        "strong_answer_hint": question.get("strong_answer_hint") or "",
    }


@router.post("/preview-questions")
async def preview_invite_questions(
    request: dict,
    client=Depends(get_authed_client),
    recruiter_id: str = Depends(get_current_user_id),
):
    candidate_id = request.get("candidate_id")
    jd_id = request.get("jd_id")
    if not candidate_id or not jd_id:
        raise HTTPException(status_code=400, detail="candidate_id and jd_id are required")

    owned_jd = (
        client.table("jd_posts")
        .select("id, title, jd_text")
        .eq("id", jd_id)
        .eq("recruiter_id", recruiter_id)
        .limit(1)
        .execute()
    )
    if not owned_jd.data:
        raise HTTPException(status_code=404, detail="Job description not found or not owned by you")

    candidate = (
        supabase.table("candidates")
        .select("id, name, email, resume_text")
        .eq("id", candidate_id)
        .limit(1)
        .execute()
    )
    if not candidate.data:
        raise HTTPException(status_code=404, detail="Candidate not found")

    from app.services.screening_agent import get_or_create_questions

    jd = owned_jd.data[0]
    cand = candidate.data[0]
    application = (
        supabase.table("jd_applications")
        .select("resume_text")
        .eq("candidate_id", candidate_id)
        .eq("jd_id", jd_id)
        .limit(1)
        .execute()
    )
    application_resume = (
        application.data[0].get("resume_text")
        if application.data
        else ""
    )
    questions, from_cache = await get_or_create_questions(
        jd_id=jd_id,
        jd_text=jd.get("jd_text") or "",
        candidate_id=candidate_id,
        resume_text=application_resume or cand.get("resume_text") or "",
    )

    return {
        "candidate_id": candidate_id,
        "candidate_name": cand.get("name") or "Candidate",
        "jd_id": jd_id,
        "jd_title": jd.get("title") or "",
        "questions": questions,
        "from_cache": from_cache,
    }


@router.post("/save-questions")
async def save_invite_questions(
    request: dict,
    client=Depends(get_authed_client),
    recruiter_id: str = Depends(get_current_user_id),
):
    candidate_id = request.get("candidate_id")
    jd_id = request.get("jd_id")
    raw_questions = request.get("questions") or []
    if not candidate_id or not jd_id:
        raise HTTPException(status_code=400, detail="candidate_id and jd_id are required")

    owned_jd = (
        client.table("jd_posts")
        .select("id")
        .eq("id", jd_id)
        .eq("recruiter_id", recruiter_id)
        .limit(1)
        .execute()
    )
    if not owned_jd.data:
        raise HTTPException(status_code=404, detail="Job description not found or not owned by you")

    questions = [
        _question_payload(question, index)
        for index, question in enumerate(raw_questions)
        if (question.get("question") or "").strip()
    ][:5]
    if len(questions) != 5:
        raise HTTPException(status_code=400, detail="Please keep exactly 5 interview questions")

    cached = (
        supabase.table("interview_questions")
        .select("questions_json")
        .eq("candidate_id", candidate_id)
        .eq("jd_id", jd_id)
        .limit(1)
        .execute()
    )
    if cached.data:
        supabase.table("interview_questions").update({
            "questions_json": questions,
        }).eq("candidate_id", candidate_id).eq("jd_id", jd_id).execute()
    else:
        supabase.table("interview_questions").insert({
            "jd_id": jd_id,
            "candidate_id": candidate_id,
            "questions_json": questions,
        }).execute()

    return {"saved": True, "questions": questions}


@router.post("/create")
async def create_invite(
    request: CreateInviteRequest,
    client=Depends(get_authed_client),
    recruiter_id: str = Depends(get_current_user_id),
):
    """
    Recruiter invites a specific candidate to screen for a JD.
    Creates a unique token tied to this candidate+JD pair.
    Resume is pre-loaded from the candidate's profile.
    """
    import re as _re
    _uuid_re = _re.compile(
        r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
        _re.I
    )
    if not _uuid_re.match(str(request.candidate_id)):
        raise HTTPException(status_code=400, detail="Invalid candidate_id")
    if not _uuid_re.match(str(request.jd_id)):
        raise HTTPException(status_code=400, detail="Invalid jd_id")

    try:
        owned_jd = (
            supabase.table("jd_posts")
            .select("id, title")
            .eq("id", request.jd_id)
            .eq("recruiter_id", recruiter_id)
            .limit(1)
            .execute()
        )
        if not owned_jd.data:
            raise HTTPException(status_code=404, detail="Job description not found or not owned by you")

        # Return existing pending/started invite rather than creating a duplicate
        existing = (
            supabase.table("screening_invites")
            .select("id, token, status")
            .eq("candidate_id", request.candidate_id)
            .eq("jd_id", request.jd_id)
            .limit(1)
            .execute()
        )
        if existing.data:
            inv = existing.data[0]
            if inv["status"] in ("pending", "started"):
                return {
                    "invite_id": inv["id"],
                    "token": inv["token"],
                    "message": "Invite already exists",
                    "status": inv["status"],
                    "screening_url": f"/screen/{inv['token']}",
                }

            if inv["status"] in ("expired", "completed"):
                token = secrets.token_urlsafe(16)
                candidate = (
                    supabase.table("candidates")
                    .select("resume_text, resume_url, name, email")
                    .eq("id", request.candidate_id)
                    .limit(1)
                    .execute()
                )
                application = (
                    supabase.table("jd_applications")
                    .select("resume_text")
                    .eq("candidate_id", request.candidate_id)
                    .eq("jd_id", request.jd_id)
                    .limit(1)
                    .execute()
                )
                candidate_data = candidate.data[0] if candidate.data else {}
                application_resume = application.data[0].get("resume_text") if application.data else ""
                refreshed = (
                    supabase.table("screening_invites")
                    .update({
                        "token": token,
                        "status": "pending",
                        "started_at": None,
                        "completed_at": None,
                        "resume_text": application_resume or candidate_data.get("resume_text", ""),
                        "resume_url": candidate_data.get("resume_url"),
                        "candidate_name": candidate_data.get("name", ""),
                        "candidate_email": candidate_data.get("email", ""),
                    })
                    .eq("id", inv["id"])
                    .execute()
                )
                if refreshed.data:
                    print(f"[create_invite] Refreshing invite — updating jd_applications: candidate_id={request.candidate_id}, jd_id={request.jd_id}")
                    app_update = client.table("jd_applications") \
                        .update({"status": "invited"}) \
                        .eq("candidate_id", request.candidate_id) \
                        .eq("jd_id", request.jd_id) \
                        .execute()
                    print(f"[create_invite] jd_applications refresh update result: {app_update.data}")
                    return {
                        "invite_id": inv["id"],
                        "token": token,
                        "message": "Invite refreshed",
                        "status": "pending",
                        "screening_url": f"/screen/{token}",
                    }

        # Fetch candidate resume
        candidate = (
            supabase.table("candidates")
            .select("id, name, email, resume_url, resume_text")
            .eq("id", request.candidate_id)
            .single()
            .execute()
        )
        if not candidate.data:
            raise HTTPException(status_code=404, detail="Candidate not found")
        application = (
            supabase.table("jd_applications")
            .select("resume_text")
            .eq("candidate_id", request.candidate_id)
            .eq("jd_id", request.jd_id)
            .limit(1)
            .execute()
        )
        application_resume = application.data[0].get("resume_text") if application.data else ""

        token = secrets.token_urlsafe(16)

        invite = (
            supabase.table("screening_invites")
            .insert({
                "candidate_id": request.candidate_id,
                "jd_id": request.jd_id,
                "recruiter_id": recruiter_id,
                "token": token,
                "status": "pending",
                "resume_url": candidate.data.get("resume_url"),
                "resume_text": application_resume or candidate.data.get("resume_text", ""),
                "candidate_name": candidate.data.get("name", ""),
                "candidate_email": candidate.data.get("email", ""),
            })
            .execute()
        )
        if not invite.data:
            raise HTTPException(status_code=500, detail="Failed to create screening invite")

        # Update application status to invited if an application exists
        print(f"[create_invite] New invite — updating jd_applications: candidate_id={request.candidate_id}, jd_id={request.jd_id}")
        app_update = client.table("jd_applications") \
            .update({"status": "invited"}) \
            .eq("candidate_id", request.candidate_id) \
            .eq("jd_id", request.jd_id) \
            .execute()
        print(f"[create_invite] jd_applications new invite update result: {app_update.data}")

        return {
            "invite_id": invite.data[0]["id"],
            "token": token,
            "candidate_name": candidate.data["name"],
            "jd_title": owned_jd.data[0]["title"],
            "status": "pending",
            "screening_url": f"/screen/{token}",
        }

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        print(f"[invites/create] ERROR: {str(e)}")
        print(traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/for-jd/{jd_id}")
async def get_invites_for_jd(
    jd_id: str,
    client=Depends(get_authed_client),
):
    """Get all invites sent for a specific JD."""
    result = (
        supabase.table("screening_invites")
        .select("*, candidates(name, email, resume_url)")
        .eq("jd_id", jd_id)
        .order("invited_at", desc=True)
        .execute()
    )
    return {"invites": result.data}


@router.patch("/expire/{invite_id}")
async def expire_invite(
    invite_id: str,
    client=Depends(get_authed_client),
):
    """Revoke a pending invite."""
    supabase.table("screening_invites") \
        .update({"status": "expired"}) \
        .eq("id", invite_id) \
        .execute()
    return {"success": True}
