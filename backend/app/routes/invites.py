import secrets
from fastapi import APIRouter, Depends, HTTPException
from app.database import supabase, get_authed_client, get_current_user_id
from app.models.schemas import CreateInviteRequest

router = APIRouter(prefix="/invites", tags=["invites"])


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
            refreshed = (
                supabase.table("screening_invites")
                .update({
                    "token": token,
                    "status": "pending",
                    "started_at": None,
                    "completed_at": None,
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
            "resume_text": candidate.data.get("resume_text", ""),
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
