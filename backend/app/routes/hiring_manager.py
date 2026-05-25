"""
Phase 5 — Hiring Manager routes with Supabase Auth + RLS.
All routes use get_authed_client so RLS filters to the recruiter's own data.
Zero new AI calls — no credit cost.
"""
from fastapi import APIRouter, HTTPException, Depends
from app.database import supabase, get_authed_client, get_current_user_id
from app.models.schemas import JDCreate, ParseJDRequest, MatchRequest, UpdateJDRequest
from app.services.matching import parse_jd, rank_candidates

router = APIRouter()


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
async def get_jd_posts(status: str = "active", client=Depends(get_authed_client)):
    """
    Returns recruiter's own JDs (RLS-filtered).
    status: "active" | "archived" | "all"
    Each JD includes screening_count and active_link_token.
    """
    query = client.table("jd_posts").select("*")
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


@router.patch("/jd/{jd_id}")
async def update_jd(jd_id: str, body: UpdateJDRequest, client=Depends(get_authed_client)):
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
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Job description not found or not owned by you")
    return {"success": True, "data": result.data[0], "message": "Job description updated"}


@router.delete("/jd/{jd_id}")
async def archive_jd(jd_id: str, client=Depends(get_authed_client)):
    """Soft-delete — sets status = 'archived'. Never hard-deletes."""
    result = (
        client.table("jd_posts")
        .update({"status": "archived"})
        .eq("id", jd_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Job description not found or not owned by you")
    return {"success": True, "message": "Job description archived"}


@router.post("/duplicate-jd/{jd_id}")
async def duplicate_jd(jd_id: str, client=Depends(get_authed_client)):
    """Creates a copy of a JD with 'Copy of …' title prefix, no screening link."""
    user_resp = client.auth.get_user()
    recruiter_id = user_resp.user.id

    original = client.table("jd_posts").select("*").eq("id", jd_id).execute()
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
async def parse_jd_endpoint(body: ParseJDRequest, client=Depends(get_authed_client)):
    jd_resp = client.table("jd_posts").select("*").eq("id", body.jd_id).execute()
    if not jd_resp.data:
        raise HTTPException(status_code=404, detail="Job description not found")

    jd_text = jd_resp.data[0]["jd_text"]
    parsed = await parse_jd(jd_text)

    client.table("jd_posts").update({"parsed_json": parsed}).eq("id", body.jd_id).execute()
    return {"jd_id": body.jd_id, "parsed_jd": parsed}


# ── Candidate matching ────────────────────────────────────────────────────

@router.post("/match-candidates")
async def match_candidates(body: MatchRequest, client=Depends(get_authed_client)):
    jd_resp = client.table("jd_posts").select("*").eq("id", body.jd_id).execute()
    if not jd_resp.data:
        raise HTTPException(status_code=404, detail="Job description not found")

    jd_row = jd_resp.data[0]
    jd_text = jd_row["jd_text"]
    parsed_jd = jd_row.get("parsed_json") or {}

    if not parsed_jd:
        parsed_jd = await parse_jd(jd_text)
        client.table("jd_posts").update({"parsed_json": parsed_jd}).eq("id", body.jd_id).execute()

    candidates_resp = (
        supabase.table("candidates").select("*").in_("id", body.candidate_ids).execute()
    )
    if not candidates_resp.data:
        raise HTTPException(status_code=404, detail="No candidates found")

    ranked = await rank_candidates(candidates_resp.data, jd_text, parsed_jd, body.weights)

    for candidate in ranked:
        supabase.table("match_scores").delete().eq("candidate_id", candidate["id"]).eq("jd_id", body.jd_id).execute()
        supabase.table("match_scores").insert({
            "candidate_id": candidate["id"],
            "jd_id": body.jd_id,
            "score_json": candidate["score_json"],
            "total_score": candidate["total_score"],
        }).execute()

    results = [
        {
            "candidate_id": c["id"],
            "candidate_name": c["name"],
            "candidate_email": c.get("email", ""),
            "total_score": c["total_score"],
            "score_json": c["score_json"],
            "recommendation": c["score_json"].get("recommendation", "weak_match"),
            "overall_summary": c["score_json"].get("overall_summary", ""),
        }
        for c in ranked
    ]
    return {"success": True, "data": {"results": results}, "message": f"Matched {len(results)} candidates"}


@router.get("/match-results/{jd_id}")
async def get_match_results(jd_id: str, client=Depends(get_authed_client)):
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
