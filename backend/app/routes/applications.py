from fastapi import APIRouter, Depends, HTTPException
from app.database import supabase, get_authed_client, get_current_user_id
from app.models.schemas import UpdateApplicationStatusRequest

router = APIRouter(prefix="/applications", tags=["applications"])


@router.get("/for-jd/{jd_id}")
async def get_applications_for_jd(
    jd_id: str,
    client=Depends(get_authed_client),
    recruiter_id: str = Depends(get_current_user_id),
):
    """
    Recruiter views all applications for a JD.
    Returns candidates with match scores, sorted by score desc.
    """
    jd = (
        supabase.table("jd_posts")
        .select("id")
        .eq("id", jd_id)
        .eq("recruiter_id", recruiter_id)
        .limit(1)
        .execute()
    )
    if not jd.data:
        raise HTTPException(status_code=404, detail="Job description not found or not owned by you")

    result = (
        supabase.table("jd_applications")
        .select("*, candidates(id, name, email, resume_url, headline, location, linkedin_url)")
        .eq("jd_id", jd_id)
        .order("match_score", desc=True)
        .execute()
    )
    return {"applications": result.data, "count": len(result.data)}


@router.patch("/status")
async def update_application_status(
    request: UpdateApplicationStatusRequest,
    client=Depends(get_authed_client),
    recruiter_id: str = Depends(get_current_user_id),
):
    """Recruiter shortlists, rejects, or marks candidate as invited."""
    status_map = {
        "advanced": "shortlisted",
        "advance": "shortlisted",
        "rejected": "rejected",
        "reject": "rejected",
        "applied": "applied",
        "shortlisted": "shortlisted",
        "invited": "invited",
    }
    requested_status = request.status or request.decision
    db_status = status_map.get((requested_status or "").strip().lower())
    if not db_status:
        raise HTTPException(status_code=400, detail="Invalid application status")

    app_query = supabase.table("jd_applications").select("id, jd_id")
    if request.application_id:
        app_query = app_query.eq("id", request.application_id)
    elif request.candidate_id and request.jd_id:
        app_query = app_query.eq("candidate_id", request.candidate_id).eq("jd_id", request.jd_id)
    else:
        raise HTTPException(status_code=400, detail="application_id or candidate_id + jd_id is required")

    app = app_query.limit(1).execute()
    if not app.data:
        raise HTTPException(status_code=404, detail="Application not found")

    application_id = app.data[0]["id"]

    jd = (
        supabase.table("jd_posts")
        .select("id")
        .eq("id", app.data[0]["jd_id"])
        .eq("recruiter_id", recruiter_id)
        .limit(1)
        .execute()
    )
    if not jd.data:
        raise HTTPException(status_code=404, detail="Application not found")

    result = (
        supabase.table("jd_applications")
        .update({"status": db_status})
        .eq("id", application_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Application not found")
    return {"success": True, "application_id": application_id, "status": db_status}
