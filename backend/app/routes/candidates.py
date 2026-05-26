import uuid
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Depends
from supabase import create_client
from app.database import supabase, get_authed_client, get_current_user_id
from app.config import settings
from app.services.resume_parser import parse_resume
from app.services.matching import score_candidate, calculate_weighted_score
from app.services.utils import truncate_resume, get_cached_match_score
from app.models.schemas import CreateApplicationRequest

router = APIRouter()


# ── Existing public/admin endpoints ──────────────────────────────────────────

@router.get("/")
async def list_candidates():
    response = supabase.table("candidates").select("*").order("created_at", desc=True).execute()
    return {"success": True, "data": {"candidates": response.data}, "message": "Candidates retrieved successfully"}


@router.post("/parse-resume")
async def parse_resume_endpoint(
    resume: UploadFile = File(...),
    _profile_id: str = Depends(get_current_user_id),
):
    """Parse a resume file and return text only — does NOT update the candidate profile.
    Used when a candidate wants to apply to a specific job with a different resume."""
    file_bytes = await resume.read()
    resume_text = parse_resume(file_bytes, resume.filename or "")
    return {"resume_text": resume_text, "filename": resume.filename}


@router.post("/upload-resume")
async def upload_resume(
    file: UploadFile = File(...),
    name: str = Form(...),
    email: str = Form(...),
):
    file_bytes = await file.read()
    resume_text = parse_resume(file_bytes, file.filename or "")

    file_path = f"{uuid.uuid4()}/{file.filename}"
    content_type = file.content_type or "application/octet-stream"

    resume_url = ""
    try:
        supabase.storage.from_("resumes").upload(
            path=file_path,
            file=file_bytes,
            file_options={"content-type": content_type},
        )
        resume_url = supabase.storage.from_("resumes").get_public_url(file_path)
    except Exception:
        pass

    response = (
        supabase.table("candidates")
        .insert({"name": name, "email": email, "resume_url": resume_url, "resume_text": resume_text})
        .execute()
    )

    if not response.data:
        raise HTTPException(status_code=500, detail="Failed to create candidate record")

    return {"success": True, "data": response.data[0], "message": "Resume uploaded successfully"}


@router.get("/jd-list")
async def get_public_jd_list():
    """
    Public endpoint — returns all active JDs for candidates to pick
    from when running resume analysis. No auth required.
    """
    svc_key = settings.SUPABASE_SERVICE_KEY or settings.SUPABASE_ANON_KEY
    client = create_client(settings.SUPABASE_URL, svc_key)
    response = (
        client.table("jd_posts")
        .select("id, title, department, location")
        .eq("status", "active")
        .order("created_at", desc=True)
        .execute()
    )
    return {"success": True, "data": {"jd_posts": response.data or []}, "message": "JDs retrieved"}


# ── Candidate self-service endpoints (all before /{candidate_id}) ─────────────

@router.get("/profile")
async def get_my_profile(
    profile_id: str = Depends(get_current_user_id),
):
    """Candidate fetches their own profile and linked candidate record."""
    profile = (
        supabase.table("profiles")
        .select("*")
        .eq("id", profile_id)
        .single()
        .execute()
    )
    candidate = (
        supabase.table("candidates")
        .select("*")
        .eq("profile_id", profile_id)
        .limit(1)
        .execute()
    )
    return {
        "profile": profile.data,
        "candidate": candidate.data[0] if candidate.data else None,
    }


@router.post("/profile/resume")
async def upload_my_resume(
    resume: UploadFile = File(...),
    profile_id: str = Depends(get_current_user_id),
):
    """Candidate uploads or replaces their resume."""
    file_bytes = await resume.read()
    resume_text = parse_resume(file_bytes, resume.filename or "")

    path = f"resumes/candidates/{profile_id}/{resume.filename}"
    resume_url = ""
    try:
        supabase.storage.from_("resumes").upload(
            path, file_bytes,
            {"content-type": resume.content_type or "application/octet-stream", "upsert": "true"},
        )
        resume_url = supabase.storage.from_("resumes").get_public_url(path)
    except Exception as e:
        print(f"[upload_my_resume] Storage error: {e}")

    existing = (
        supabase.table("candidates")
        .select("id")
        .eq("profile_id", profile_id)
        .limit(1)
        .execute()
    )

    if existing.data:
        candidate_id = existing.data[0]["id"]
        supabase.table("candidates").update({
            "resume_text": resume_text,
            "resume_url": resume_url,
            "resume_filename": resume.filename,
        }).eq("id", candidate_id).execute()
    else:
        profile = (
            supabase.table("profiles")
            .select("email, full_name")
            .eq("id", profile_id)
            .single()
            .execute()
        )
        if not profile.data:
            raise HTTPException(status_code=400, detail="Profile not found — complete signup first")
        result = (
            supabase.table("candidates")
            .insert({
                "profile_id": profile_id,
                "name": profile.data.get("full_name", ""),
                "email": profile.data.get("email", ""),
                "resume_text": resume_text,
                "resume_url": resume_url,
                "resume_filename": resume.filename,
            })
            .execute()
        )
        candidate_id = result.data[0]["id"]

    # Record in upload history (best-effort)
    try:
        supabase.table("candidate_resume_uploads").insert({
            "candidate_id": candidate_id,
            "filename": resume.filename or "unknown",
            "resume_url": resume_url,
        }).execute()
    except Exception as e:
        print(f"[upload_my_resume] Failed to record upload history: {e}")

    return {
        "candidate_id": candidate_id,
        "resume_url": resume_url,
        "resume_filename": resume.filename,
        "resume_text_preview": resume_text[:200],
    }


@router.get("/jd-pool")
async def get_open_jds(
    _profile_id: str = Depends(get_current_user_id),
):
    """Returns all open JDs (visibility='open', status='active') for the candidate job board.
    Company name is fetched separately — jd_posts→profiles FK may not exist in all deployments."""
    result = (
        supabase.table("jd_posts")
        .select("id, title, department, location, created_at, recruiter_id")
        .eq("visibility", "open")
        .eq("status", "active")
        .order("created_at", desc=True)
        .execute()
    )
    jds = result.data or []

    # Enrich with company names via a separate profiles lookup
    if jds:
        recruiter_ids = list({j["recruiter_id"] for j in jds if j.get("recruiter_id")})
        try:
            profiles_resp = (
                supabase.table("profiles")
                .select("id, company_name")
                .in_("id", recruiter_ids)
                .execute()
            )
            profile_map = {p["id"]: p.get("company_name", "") for p in (profiles_resp.data or [])}
        except Exception:
            profile_map = {}
        for j in jds:
            j["company_name"] = profile_map.get(j.get("recruiter_id", ""), "")

    return {"jds": jds, "count": len(jds)}


@router.post("/apply")
async def apply_to_jd(
    request: CreateApplicationRequest,
    profile_id: str = Depends(get_current_user_id),
):
    """
    Candidate applies to an open JD.
    Computes match score once on apply — cached in match_scores, not recomputed.
    CREDIT RULE: cache check before every Claude call.
    """
    # Resolve candidate record
    candidate_row = (
        supabase.table("candidates")
        .select("id, name, resume_text, resume_url")
        .eq("profile_id", profile_id)
        .limit(1)
        .execute()
    )
    if not candidate_row.data:
        raise HTTPException(
            status_code=400,
            detail="Please upload your resume to your profile before applying",
        )

    candidate = candidate_row.data[0]
    candidate_id = candidate["id"]
    resume_text = request.resume_text or candidate.get("resume_text", "")

    # Deduplicate: return existing application if any
    existing = (
        supabase.table("jd_applications")
        .select("id, status, match_score")
        .eq("candidate_id", candidate_id)
        .eq("jd_id", request.jd_id)
        .limit(1)
        .execute()
    )
    if existing.data:
        return {
            "application_id": existing.data[0]["id"],
            "status": existing.data[0]["status"],
            "match_score": existing.data[0]["match_score"],
            "message": "Already applied",
        }

    # ── Compute match score (credit-saving: cache first) ──────────────────
    match_score = 0.0
    match_json: dict = {}

    cached = get_cached_match_score(candidate_id, request.jd_id)
    if cached:
        match_score = cached.get("total_score", 0.0)
        match_json = cached.get("score_json", {})
    else:
        jd = (
            supabase.table("jd_posts")
            .select("jd_text, parsed_json, title")
            .eq("id", request.jd_id)
            .single()
            .execute()
        )
        if not jd.data:
            raise HTTPException(status_code=404, detail="Job description not found")

        parsed_jd = jd.data.get("parsed_json") or {}
        match_json = await score_candidate(
            resume_text=truncate_resume(resume_text),
            parsed_jd=parsed_jd,
            candidate_name=candidate.get("name", ""),
            candidate_id=candidate_id,
            jd_id=request.jd_id,
        )
        match_score = calculate_weighted_score(match_json)

        # Persist to match_scores so future calls are cache hits
        existing_score = (
            supabase.table("match_scores")
            .select("id")
            .eq("candidate_id", candidate_id)
            .eq("jd_id", request.jd_id)
            .limit(1)
            .execute()
        )
        # Only cache a real score — never persist a failed/default result
        if not existing_score.data and match_score > 0 and "Unable to score" not in (
            match_json.get("overall_summary", "")
        ):
            supabase.table("match_scores").insert({
                "candidate_id": candidate_id,
                "jd_id": request.jd_id,
                "score_json": match_json,
                "total_score": match_score,
            }).execute()

    # Create application record
    result = (
        supabase.table("jd_applications")
        .insert({
            "candidate_id": candidate_id,
            "jd_id": request.jd_id,
            "cover_note": request.cover_note,
            "match_score": match_score,
            "status": "applied",
        })
        .execute()
    )

    return {
        "application_id": result.data[0]["id"],
        "match_score": match_score,
        "status": "applied",
        "message": "Application submitted successfully",
    }


@router.get("/my-applications")
async def get_my_applications(
    profile_id: str = Depends(get_current_user_id),
):
    """Candidate sees all their applications and current statuses."""
    candidate = (
        supabase.table("candidates")
        .select("id")
        .eq("profile_id", profile_id)
        .limit(1)
        .execute()
    )
    if not candidate.data:
        return {"applications": []}

    result = (
        supabase.table("jd_applications")
        .select("*, jd_posts(title, department, location)")
        .eq("candidate_id", candidate.data[0]["id"])
        .order("applied_at", desc=True)
        .execute()
    )
    return {"applications": result.data or []}


@router.get("/my-invites")
async def get_my_invites(
    profile_id: str = Depends(get_current_user_id),
):
    """Candidate sees all screening invites sent by recruiters.

    Searches by both profile_id and email so that invites created against
    manually-added candidate records (no profile_id) are still visible once
    the candidate registers and links an auth account.
    """
    # ── Collect candidate IDs with small, direct queries ─────────────────────
    candidate_ids: set = set()

    profile_row = (
        supabase.table("profiles")
        .select("email")
        .eq("id", profile_id)
        .single()
        .execute()
    )
    email = ((profile_row.data or {}).get("email") or "").lower().strip()

    by_profile = (
        supabase.table("candidates")
        .select("id")
        .eq("profile_id", profile_id)
        .execute()
    )
    for candidate in by_profile.data or []:
        candidate_ids.add(candidate["id"])

    if email:
        by_email = (
            supabase.table("candidates")
            .select("id")
            .eq("email", email)
            .execute()
        )
        for candidate in by_email.data or []:
            candidate_ids.add(candidate["id"])

    if not candidate_ids:
        return {"invites": []}

    invites_result = (
        supabase.table("screening_invites")
        .select("id, candidate_id, jd_id, token, status, invited_at, started_at, completed_at, expires_at")
        .in_("candidate_id", list(candidate_ids))
        .order("invited_at", desc=True)
        .limit(50)
        .execute()
    )
    invites = invites_result.data or []
    if not invites:
        return {"invites": []}

    jd_ids = list({invite["jd_id"] for invite in invites if invite.get("jd_id")})
    jd_map = {}
    if jd_ids:
        jd_result = (
            supabase.table("jd_posts")
            .select("id, title, department, location")
            .in_("id", jd_ids)
            .execute()
        )
        jd_map = {jd["id"]: jd for jd in jd_result.data or []}

    for invite in invites:
        invite["jd_posts"] = jd_map.get(invite.get("jd_id"), {})

    return {"invites": invites}


@router.get("/upload-history")
async def get_upload_history(
    profile_id: str = Depends(get_current_user_id),
):
    """Returns the candidate's resume upload history, newest first."""
    candidate = (
        supabase.table("candidates")
        .select("id")
        .eq("profile_id", profile_id)
        .limit(1)
        .execute()
    )
    if not candidate.data:
        return {"uploads": []}

    result = (
        supabase.table("candidate_resume_uploads")
        .select("id, filename, resume_url, uploaded_at")
        .eq("candidate_id", candidate.data[0]["id"])
        .order("uploaded_at", desc=True)
        .execute()
    )
    return {"uploads": result.data or []}


# ── Parameterised route — must stay last ─────────────────────────────────────

@router.get("/{candidate_id}")
async def get_candidate(candidate_id: str):
    response = supabase.table("candidates").select("*").eq("id", candidate_id).execute()
    if not response.data:
        raise HTTPException(status_code=404, detail="Candidate not found")
    return {"success": True, "data": response.data[0], "message": "Candidate retrieved successfully"}
