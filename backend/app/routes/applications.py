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
    app = (
        supabase.table("jd_applications")
        .select("id, jd_id")
        .eq("id", request.application_id)
        .limit(1)
        .execute()
    )
    if not app.data:
        raise HTTPException(status_code=404, detail="Application not found")

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
        .update({"status": request.status})
        .eq("id", request.application_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Application not found")
    return {"success": True, "status": request.status}
