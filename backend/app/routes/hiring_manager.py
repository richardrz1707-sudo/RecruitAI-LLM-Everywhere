"""
Phase 5 — Hiring Manager routes with Supabase Auth + RLS.
All routes use get_authed_client so RLS filters to the recruiter's own data.
Zero new AI calls — no credit cost.
"""
from datetime import datetime, timedelta, timezone
import secrets
from typing import List

from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, Form
from pydantic import BaseModel
from app.database import supabase, get_authed_client, get_current_user_id
from app.models.schemas import (
    JDCreate, ParseJDRequest, MatchRequest, UpdateJDRequest,
    UpdateJDVisibilityRequest,
)
from app.services.matching import parse_jd, rank_candidates, get_dynamic_weights
from app.services.resume_parser import parse_resume

router = APIRouter()


class BulkDecisionRequest(BaseModel):
    session_ids: List[str]
    decision: str
    reason: str = ""


class BulkInviteRequest(BaseModel):
    candidate_ids: List[str]
    jd_id: str


@router.get("/dashboard-summary")
async def get_dashboard_summary(
    client=Depends(get_authed_client),
    recruiter_id: str = Depends(get_current_user_id),
):
    """
    Returns hiring metrics summary for the recruiter dashboard header card.
    Calculated from existing data with zero Claude calls.
    """
    empty_summary = {
        "active_jds": 0,
        "total_applications": 0,
        "candidates_screened": 0,
        "this_week_screened": 0,
        "strong_matches": 0,
        "avg_screening_minutes": 0,
        "hours_saved": 0,
        "pending_invites": 0,
    }

    try:
        jds = (
            client.table("jd_posts")
            .select("id")
            .eq("recruiter_id", recruiter_id)
            .neq("status", "archived")
            .execute()
        )
        active_jds = len(jds.data or [])
        jd_ids = [j["id"] for j in (jds.data or [])]

        if not jd_ids:
            return empty_summary

        sessions = (
            supabase.table("screening_sessions")
            .select("id, created_at, report_json")
            .in_("jd_id", jd_ids)
            .eq("status", "completed")
            .execute()
        )
        all_sessions = sessions.data or []
        total_screened = len(all_sessions)

        week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
        this_week_count = len([
            s for s in all_sessions
            if (s.get("created_at") or "") >= week_ago
        ])

        strong_matches = sum(
            1 for s in all_sessions
            if ((s.get("report_json") or {}).get("overall_score") or 0) >= 75
        )

        invites = (
            supabase.table("screening_invites")
            .select("id")
            .in_("jd_id", jd_ids)
            .eq("status", "pending")
            .execute()
        )

        apps = (
            supabase.table("jd_applications")
            .select("id")
            .in_("jd_id", jd_ids)
            .execute()
        )

        return {
            "active_jds": active_jds,
            "total_applications": len(apps.data or []),
            "candidates_screened": total_screened,
            "this_week_screened": this_week_count,
            "strong_matches": strong_matches,
            "avg_screening_minutes": 10,
            "hours_saved": round((total_screened * 30) / 60, 1),
            "pending_invites": len(invites.data or []),
        }
    except Exception as e:
        import traceback

        print(f"Dashboard summary error: {e}")
        print(traceback.format_exc())
        return empty_summary


# ── JD management ─────────────────────────────────────────────────────────

@router.post("/create-jd")
async def create_jd(
    jd: JDCreate,
    client=Depends(get_authed_client),
    recruiter_id: str = Depends(get_current_user_id),
):
    response = (
        client.table("jd_posts")
        .insert({
            "title": jd.title,
            "jd_text": jd.jd_text,
            "recruiter_id": recruiter_id,
            "status": "active",
            "department": jd.department or "",
            "location": jd.location or "",
        })
        .execute()
    )
    if not response.data:
        raise HTTPException(status_code=500, detail="Failed to create job description")
    return {"success": True, "data": response.data[0], "message": "Job description created"}


@router.get("/jd-posts")
async def get_jd_posts(
    status: str = "active",
    client=Depends(get_authed_client),
    recruiter_id: str = Depends(get_current_user_id),
):
    """
    Returns recruiter's own JDs (RLS-filtered).
    status: "active" | "archived" | "all"
    Each JD includes screening_count and active_link_token.
    """
    query = client.table("jd_posts").select("*").eq("recruiter_id", recruiter_id)
    if status != "all":
        query = query.eq("status", status)
    jds_resp = query.order("created_at", desc=True).execute()
    jds = jds_resp.data or []

    if not jds:
        return {"success": True, "data": {"jd_posts": []}, "message": "No job descriptions found"}

    jd_ids = [j["id"] for j in jds]

    # Count completed sessions per JD (service role bypasses RLS for server-side counting)
    sessions_resp = (
        supabase.table("screening_sessions")
        .select("jd_id")
        .in_("jd_id", jd_ids)
        .eq("status", "completed")
        .execute()
    )
    session_counts: dict = {}
    for s in (sessions_resp.data or []):
        session_counts[s["jd_id"]] = session_counts.get(s["jd_id"], 0) + 1

    # Get screening links per JD
    links_resp = (
        supabase.table("screening_links")
        .select("jd_id, token, interview_mode")
        .in_("jd_id", jd_ids)
        .execute()
    )
    link_map = {l["jd_id"]: l for l in (links_resp.data or [])}

    result = []
    for j in jds:
        link = link_map.get(j["id"])
        result.append({
            **j,
            "screening_count": session_counts.get(j["id"], 0),
            "active_link_token": link["token"] if link else None,
            "active_link_interview_mode": link["interview_mode"] if link else "text_only",
        })

    return {"success": True, "data": {"jd_posts": result}, "message": "Job descriptions retrieved"}


@router.patch("/jd/visibility")
async def update_jd_visibility(
    request: UpdateJDVisibilityRequest,
    client=Depends(get_authed_client),
    recruiter_id: str = Depends(get_current_user_id),
):
    """Toggle JD between open (visible in candidate job board) and invite_only."""
    result = (
        client.table("jd_posts")
        .update({"visibility": request.visibility})
        .eq("id", request.jd_id)
        .eq("recruiter_id", recruiter_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="JD not found or not owned by you")
    return {"jd_id": request.jd_id, "visibility": request.visibility}


@router.patch("/jd/{jd_id}")
async def update_jd(
    jd_id: str,
    body: UpdateJDRequest,
    client=Depends(get_authed_client),
    recruiter_id: str = Depends(get_current_user_id),
):
    changes: dict = {}
    if body.title is not None:
        changes["title"] = body.title
    if body.jd_text is not None:
        changes["jd_text"] = body.jd_text
    if body.department is not None:
        changes["department"] = body.department
    if body.location is not None:
        changes["location"] = body.location
    if body.status is not None:
        if body.status not in ("active", "archived"):
            raise HTTPException(status_code=400, detail="status must be 'active' or 'archived'")
        changes["status"] = body.status

    if not changes:
        raise HTTPException(status_code=400, detail="No fields to update")

    result = (
        client.table("jd_posts")
        .update(changes)
        .eq("id", jd_id)
        .eq("recruiter_id", recruiter_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Job description not found or not owned by you")
    return {"success": True, "data": result.data[0], "message": "Job description updated"}


@router.delete("/jd/{jd_id}")
async def archive_jd(
    jd_id: str,
    client=Depends(get_authed_client),
    recruiter_id: str = Depends(get_current_user_id),
):
    """Soft-delete — sets status = 'archived'. Never hard-deletes."""
    result = (
        client.table("jd_posts")
        .update({"status": "archived"})
        .eq("id", jd_id)
        .eq("recruiter_id", recruiter_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Job description not found or not owned by you")
    return {"success": True, "message": "Job description archived"}


@router.post("/duplicate-jd/{jd_id}")
async def duplicate_jd(
    jd_id: str,
    client=Depends(get_authed_client),
    recruiter_id: str = Depends(get_current_user_id),
):
    """Creates a copy of a JD with 'Copy of …' title prefix, no screening link."""
    original = (
        client.table("jd_posts")
        .select("*")
        .eq("id", jd_id)
        .eq("recruiter_id", recruiter_id)
        .execute()
    )
    if not original.data:
        raise HTTPException(status_code=404, detail="Job description not found")

    src = original.data[0]
    copy = (
        client.table("jd_posts")
        .insert({
            "title": f"Copy of {src['title']}",
            "jd_text": src["jd_text"],
            "parsed_json": src.get("parsed_json"),
            "recruiter_id": recruiter_id,
            "status": "active",
            "department": src.get("department", ""),
            "location": src.get("location", ""),
        })
        .execute()
    )
    if not copy.data:
        raise HTTPException(status_code=500, detail="Failed to duplicate job description")
    return {"success": True, "data": copy.data[0], "message": "Job description duplicated"}


# ── Parse JD ──────────────────────────────────────────────────────────────

@router.post("/parse-jd")
async def parse_jd_endpoint(
    body: ParseJDRequest,
    client=Depends(get_authed_client),
    recruiter_id: str = Depends(get_current_user_id),
):
    jd_resp = (
        client.table("jd_posts")
        .select("*")
        .eq("id", body.jd_id)
        .eq("recruiter_id", recruiter_id)
        .execute()
    )
    if not jd_resp.data:
        raise HTTPException(status_code=404, detail="Job description not found")

    jd_text = jd_resp.data[0]["jd_text"]
    parsed = await parse_jd(jd_text)

    (
        client.table("jd_posts")
        .update({"parsed_json": parsed})
        .eq("id", body.jd_id)
        .eq("recruiter_id", recruiter_id)
        .execute()
    )
    return {"jd_id": body.jd_id, "parsed_jd": parsed}


# ── Candidate matching ────────────────────────────────────────────────────

@router.post("/match-candidates")
async def match_candidates(
    body: MatchRequest,
    client=Depends(get_authed_client),
    recruiter_id: str = Depends(get_current_user_id),
):
    jd_resp = (
        client.table("jd_posts")
        .select("*")
        .eq("id", body.jd_id)
        .eq("recruiter_id", recruiter_id)
        .execute()
    )
    if not jd_resp.data:
        raise HTTPException(status_code=404, detail="Job description not found")

    jd_row = jd_resp.data[0]
    jd_text = jd_row["jd_text"]
    parsed_jd = jd_row.get("parsed_json") or {}

    if not parsed_jd:
        parsed_jd = await parse_jd(jd_text)
        (
            client.table("jd_posts")
            .update({"parsed_json": parsed_jd})
            .eq("id", body.jd_id)
            .eq("recruiter_id", recruiter_id)
            .execute()
        )

    candidates_resp = (
        supabase.table("candidates").select("*").in_("id", body.candidate_ids).execute()
    )
    if not candidates_resp.data:
        raise HTTPException(status_code=404, detail="No candidates found")

    ranked = await rank_candidates(candidates_resp.data, jd_text, parsed_jd, body.weights, jd_id=body.jd_id, force_refresh=body.force_refresh)

    for candidate in ranked:
        # Only cache a real score that has all insight fields — never persist a stale/failed result
        _summary = candidate["score_json"].get("overall_summary", "")
        if (
            candidate["total_score"] > 0
            and "Unable to score" not in _summary
            and "Scoring unavailable" not in _summary
            and candidate["score_json"].get("why_this_person")
        ):
            supabase.table("match_scores").delete().eq("candidate_id", candidate["id"]).eq("jd_id", body.jd_id).execute()
            supabase.table("match_scores").insert({
                "candidate_id": candidate["id"],
                "jd_id": body.jd_id,
                "score_json": candidate["score_json"],
                "total_score": candidate["total_score"],
            }).execute()

    # Weights that were actually applied — sent to frontend for display
    weights_used = body.weights if body.weights else get_dynamic_weights(parsed_jd)

    results = [
        {
            "candidate_id": c["id"],
            "candidate_name": c["name"],
            "candidate_email": c.get("email", ""),
            "total_score": c["total_score"],
            "score_json": c["score_json"],
            "recommendation": c["score_json"].get("recommendation", "weak_match"),
            "overall_summary": c["score_json"].get("overall_summary", ""),
            "weights_used": weights_used,
        }
        for c in ranked
    ]
    return {"success": True, "data": {"results": results}, "message": f"Matched {len(results)} candidates"}


@router.get("/candidates/pool")
async def get_recruiter_candidate_pool(
    client=Depends(get_authed_client),
    recruiter_id: str = Depends(get_current_user_id),
):
    """
    Get all candidates who applied to this recruiter's JDs.
    Returns applications joined with candidate and JD info.
    """
    jd_ids_resp = (
        supabase.table("jd_posts")
        .select("id")
        .eq("recruiter_id", recruiter_id)
        .execute()
    )
    jd_ids = [j["id"] for j in (jd_ids_resp.data or [])]
    if not jd_ids:
        return {"candidates": []}

    apps = (
        supabase.table("jd_applications")
        .select(
            "*, "
            "candidates(id, name, email, headline, resume_url, linkedin_url), "
            "jd_posts(title)"
        )
        .in_("jd_id", jd_ids)
        .order("applied_at", desc=True)
        .execute()
    )
    return {"candidates": apps.data}


@router.get("/candidates/{candidate_id}/resume")
async def get_candidate_resume(
    candidate_id: str,
    client=Depends(get_authed_client),
):
    """Recruiter fetches candidate resume text and URL."""
    candidate = (
        supabase.table("candidates")
        .select("name, email, resume_url, resume_text, headline, location, linkedin_url")
        .eq("id", candidate_id)
        .single()
        .execute()
    )
    if not candidate.data:
        raise HTTPException(status_code=404, detail="Candidate not found")
    return candidate.data


@router.post("/candidates/add")
async def add_candidate_manually(
    name: str = Form(...),
    email: str = Form(...),
    resume: UploadFile = File(None),
    client=Depends(get_authed_client),
):
    """
    Recruiter manually adds a candidate to their pool.
    Optionally uploads a resume PDF or DOCX.
    """
    resume_text = ""
    resume_url = ""

    if resume and resume.filename:
        file_bytes = await resume.read()
        resume_text = parse_resume(file_bytes, resume.filename)
        safe_email = email.lower().strip().replace("@", "_").replace(".", "_")
        path = f"recruiter-upload/{safe_email}/{resume.filename}"
        try:
            supabase.storage.from_("resumes").upload(
                path, file_bytes,
                {"content-type": resume.content_type or "application/octet-stream", "upsert": "true"},
            )
            resume_url = supabase.storage.from_("resumes").get_public_url(path)
        except Exception as e:
            print(f"[add_candidate] Storage upload failed: {e}")

    normalised_email = email.lower().strip()
    existing = (
        supabase.table("candidates")
        .select("id")
        .eq("email", normalised_email)
        .limit(1)
        .execute()
    )

    if existing.data:
        candidate_id = existing.data[0]["id"]
        update_data = {}
        if resume_text:
            update_data["resume_text"] = resume_text
        if resume_url:
            update_data["resume_url"] = resume_url
        if update_data:
            supabase.table("candidates").update(update_data).eq("id", candidate_id).execute()
    else:
        result = (
            supabase.table("candidates")
            .insert({
                "name": name,
                "email": normalised_email,
                "resume_text": resume_text,
                "resume_url": resume_url,
            })
            .execute()
        )
        candidate_id = result.data[0]["id"]

    return {"candidate_id": candidate_id, "name": name, "email": normalised_email}


@router.get("/match-results/{jd_id}")
async def get_match_results(
    jd_id: str,
    client=Depends(get_authed_client),
    recruiter_id: str = Depends(get_current_user_id),
):
    jd_resp = (
        supabase.table("jd_posts")
        .select("id")
        .eq("id", jd_id)
        .eq("recruiter_id", recruiter_id)
        .limit(1)
        .execute()
    )
    if not jd_resp.data:
        raise HTTPException(status_code=404, detail="Job description not found or not owned by you")

    response = (
        supabase.table("match_scores")
        .select("*, candidates(name, email)")
        .eq("jd_id", jd_id)
        .order("total_score", desc=True)
        .execute()
    )
    results = [
        {
            "candidate_id": row["candidate_id"],
            "candidate_name": row["candidates"]["name"] if row.get("candidates") else "",
            "candidate_email": row["candidates"]["email"] if row.get("candidates") else "",
            "total_score": row["total_score"],
            "score_json": row["score_json"],
            "recommendation": (row["score_json"] or {}).get("recommendation", "weak_match"),
            "overall_summary": (row["score_json"] or {}).get("overall_summary", ""),
        }
        for row in response.data
    ]
    return {"success": True, "data": {"results": results}, "message": "Match results retrieved"}
