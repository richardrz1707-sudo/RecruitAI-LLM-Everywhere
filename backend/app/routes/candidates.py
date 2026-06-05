import uuid
import secrets
from urllib.parse import urlparse
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Depends
from app.database import supabase, get_authed_client, get_current_user_id, get_svc_client, create_supabase_client
from app.config import settings
from app.services.resume_parser import parse_resume
from app.services.matching import (
    fallback_score_candidate,
    parse_jd,
    score_candidate,
    calculate_weighted_score,
)
from app.services.utils import truncate_resume, get_cached_match_score
from app.models.schemas import CandidateProfileUpdate, CreateApplicationRequest, CandidateJobMatchRequest

router = APIRouter()


def _is_real_ai_match(score_json: dict | None, total_score: float | int | None = None) -> bool:
    if not score_json or (total_score or 0) <= 0:
        return False
    summary = score_json.get("overall_summary", "")
    return (
        "Unable to score" not in summary
        and "Scoring unavailable" not in summary
        and "Estimated match score" not in summary
        and bool(score_json.get("why_this_person"))
    )


def _normalise_linkedin_url(value: str | None) -> str:
    url = (value or "").strip()
    if not url:
        return ""
    if "://" not in url:
        url = f"https://{url}"
    parsed = urlparse(url)
    host = (parsed.netloc or "").lower()
    if parsed.scheme not in ("http", "https") or not host:
        raise HTTPException(status_code=400, detail="Please enter a valid LinkedIn profile URL")
    if host != "linkedin.com" and not host.endswith(".linkedin.com"):
        raise HTTPException(status_code=400, detail="Please enter a LinkedIn profile URL")
    return url


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
    client = create_supabase_client(settings.SUPABASE_URL, svc_key)
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


@router.patch("/profile")
async def update_my_profile(
    update: CandidateProfileUpdate,
    profile_id: str = Depends(get_current_user_id),
):
    """Candidate updates optional profile details stored on their candidate record."""
    profile = (
        supabase.table("profiles")
        .select("email, full_name")
        .eq("id", profile_id)
        .single()
        .execute()
    )
    if not profile.data:
        raise HTTPException(status_code=400, detail="Profile not found")

    changes = {}
    if update.headline is not None:
        changes["headline"] = update.headline.strip()
    if update.location is not None:
        changes["location"] = update.location.strip()
    if update.linkedin_url is not None:
        changes["linkedin_url"] = _normalise_linkedin_url(update.linkedin_url)

    if not changes:
        return {"candidate": None}

    existing = (
        supabase.table("candidates")
        .select("id")
        .eq("profile_id", profile_id)
        .limit(1)
        .execute()
    )
    if existing.data:
        result = (
            supabase.table("candidates")
            .update(changes)
            .eq("id", existing.data[0]["id"])
            .execute()
        )
    else:
        result = (
            supabase.table("candidates")
            .insert({
                "profile_id": profile_id,
                "name": profile.data.get("full_name", ""),
                "email": profile.data.get("email", ""),
                **changes,
            })
            .execute()
        )
    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to update candidate profile")
    return {"candidate": result.data[0]}


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

    # Upload history is read from resume_analyses — no separate insert needed

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
        .not_.eq("status", "archived")
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


@router.get("/jobs/{jd_id}")
async def get_candidate_job_detail(
    jd_id: str,
    profile_id: str = Depends(get_current_user_id),
):
    """Candidate-safe JD detail for open jobs, applied jobs, or invited jobs."""
    jd_resp = (
        supabase.table("jd_posts")
        .select("id, title, department, location, jd_text, status, visibility")
        .eq("id", jd_id)
        .limit(1)
        .execute()
    )
    if not jd_resp.data:
        raise HTTPException(status_code=404, detail="Job not found")

    jd = jd_resp.data[0]
    if jd.get("visibility") == "open" and jd.get("status") != "archived":
        return {"job": jd}

    candidate = (
        supabase.table("candidates")
        .select("id")
        .eq("profile_id", profile_id)
        .limit(1)
        .execute()
    )
    candidate_id = candidate.data[0]["id"] if candidate.data else None
    if not candidate_id:
        raise HTTPException(status_code=404, detail="Job not found")

    application = (
        supabase.table("jd_applications")
        .select("id")
        .eq("candidate_id", candidate_id)
        .eq("jd_id", jd_id)
        .limit(1)
        .execute()
    )
    if application.data:
        return {"job": jd}

    invite = (
        supabase.table("screening_invites")
        .select("id")
        .eq("candidate_id", candidate_id)
        .eq("jd_id", jd_id)
        .limit(1)
        .execute()
    )
    if invite.data:
        return {"job": jd}

    raise HTTPException(status_code=404, detail="Job not found")


@router.post("/match-jobs")
async def match_candidate_jobs(
    request: CandidateJobMatchRequest,
    profile_id: str = Depends(get_current_user_id),
):
    """Scores the signed-in candidate against selected open jobs without applying."""
    jd_ids = list(dict.fromkeys([jd_id for jd_id in request.jd_ids if jd_id]))
    if not jd_ids:
        raise HTTPException(status_code=400, detail="Please select at least one job")

    candidate_row = (
        supabase.table("candidates")
        .select("id, name, resume_text")
        .eq("profile_id", profile_id)
        .limit(1)
        .execute()
    )
    if not candidate_row.data:
        raise HTTPException(status_code=400, detail="Please upload your resume to your profile first")

    candidate = candidate_row.data[0]
    candidate_id = candidate["id"]
    resume_text = candidate.get("resume_text") or ""
    if not resume_text.strip():
        raise HTTPException(status_code=400, detail="Please upload a resume with readable text first")

    jd_resp = (
        supabase.table("jd_posts")
        .select("id, title, department, location, jd_text, parsed_json")
        .in_("id", jd_ids)
        .eq("visibility", "open")
        .not_.eq("status", "archived")
        .execute()
    )
    jd_rows = jd_resp.data or []
    if not jd_rows:
        raise HTTPException(status_code=404, detail="No selected open jobs found")

    results = []
    for jd in jd_rows:
        jd_id = jd["id"]
        cached = None if request.force_refresh else get_cached_match_score(candidate_id, jd_id)
        cached_score = cached.get("total_score", 0) if cached else 0
        cached_json = cached.get("score_json", {}) if cached else {}

        if _is_real_ai_match(cached_json, cached_score):
            match_json = cached_json
            match_score = cached_score
            from_cache = True
        else:
            parsed_jd = jd.get("parsed_json") or {}
            if not parsed_jd:
                parsed_jd = await parse_jd(jd.get("jd_text", ""))
                if parsed_jd:
                    supabase.table("jd_posts").update({"parsed_json": parsed_jd}).eq("id", jd_id).execute()

            match_json = await score_candidate(
                resume_text=truncate_resume(resume_text),
                parsed_jd=parsed_jd,
                candidate_name=candidate.get("name", ""),
                candidate_id=candidate_id,
                jd_id=jd_id,
                force_refresh=request.force_refresh,
            )
            match_score = calculate_weighted_score(match_json)
            if match_score <= 0 or "Unable to score" in match_json.get("overall_summary", ""):
                match_json = fallback_score_candidate(
                    resume_text=truncate_resume(resume_text),
                    jd_text=jd.get("jd_text", ""),
                    parsed_jd=parsed_jd,
                )
                match_score = calculate_weighted_score(match_json)

            if _is_real_ai_match(match_json, match_score):
                existing_score = (
                    supabase.table("match_scores")
                    .select("id")
                    .eq("candidate_id", candidate_id)
                    .eq("jd_id", jd_id)
                    .limit(1)
                    .execute()
                )
                if existing_score.data:
                    supabase.table("match_scores").update({
                        "score_json": match_json,
                        "total_score": match_score,
                    }).eq("id", existing_score.data[0]["id"]).execute()
                else:
                    supabase.table("match_scores").insert({
                        "candidate_id": candidate_id,
                        "jd_id": jd_id,
                        "score_json": match_json,
                        "total_score": match_score,
                    }).execute()
            from_cache = False

        hard_skills = match_json.get("hard_skills_match") or {}
        results.append({
            "jd_id": jd_id,
            "title": jd.get("title", ""),
            "department": jd.get("department", ""),
            "location": jd.get("location", ""),
            "total_score": match_score,
            "overall_summary": match_json.get("why_this_person") or match_json.get("overall_summary", ""),
            "matched_skills": hard_skills.get("matched", []),
            "missing_skills": hard_skills.get("gaps", []),
            "recommendation": match_json.get("recommendation", "weak_match"),
            "score_json": match_json,
            "from_cache": from_cache,
        })

    return {"success": True, "data": {"results": results}, "message": f"Matched {len(results)} jobs"}

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
        .select("id, name, resume_text, resume_url, linkedin_url")
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

    # Deduplicate: return existing application if it already has a real score.
    # Older failed runs may have stored 0; those should be recomputed.
    existing = (
        supabase.table("jd_applications")
        .select("id, status, match_score")
        .eq("candidate_id", candidate_id)
        .eq("jd_id", request.jd_id)
        .limit(1)
        .execute()
    )
    existing_app = existing.data[0] if existing.data else None

    cached = get_cached_match_score(candidate_id, request.jd_id)
    cached_score = cached.get("total_score", 0) if cached else 0
    cached_json = cached.get("score_json", {}) if cached else {}
    if existing_app and _is_real_ai_match(cached_json, cached_score):
        return {
            "application_id": existing_app["id"],
            "status": existing_app["status"],
            "match_score": cached_score,
            "message": "Already applied",
        }

    if not resume_text.strip():
        raise HTTPException(
            status_code=400,
            detail="Please upload a resume with readable text before applying",
        )

    # ── Compute match score (credit-saving: cache first) ──────────────────
    match_score = 0.0
    match_json: dict = {}

    if _is_real_ai_match(cached_json, cached_score):
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
        if not parsed_jd:
            parsed_jd = await parse_jd(jd.data.get("jd_text", ""))
            if parsed_jd:
                supabase.table("jd_posts").update({"parsed_json": parsed_jd}).eq("id", request.jd_id).execute()

        match_json = await score_candidate(
            resume_text=truncate_resume(resume_text),
            parsed_jd=parsed_jd,
            candidate_name=candidate.get("name", ""),
            candidate_id=candidate_id,
            jd_id=request.jd_id,
        )
        match_score = calculate_weighted_score(match_json)
        if match_score <= 0 or "Unable to score" in match_json.get("overall_summary", ""):
            match_json = fallback_score_candidate(
                resume_text=truncate_resume(resume_text),
                jd_text=jd.data.get("jd_text", ""),
                parsed_jd=parsed_jd,
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
        if _is_real_ai_match(match_json, match_score):
            if existing_score.data:
                supabase.table("match_scores").update({
                    "score_json": match_json,
                    "total_score": match_score,
                }).eq("id", existing_score.data[0]["id"]).execute()
            else:
                supabase.table("match_scores").insert({
                    "candidate_id": candidate_id,
                    "jd_id": request.jd_id,
                    "score_json": match_json,
                    "total_score": match_score,
                }).execute()

    if match_score <= 0:
        raise HTTPException(
            status_code=500,
            detail="Unable to calculate match score. Please make sure your resume text is readable.",
        )

    if existing_app:
        result = (
            supabase.table("jd_applications")
            .update({
                "cover_note": request.cover_note,
                "match_score": match_score,
            })
            .eq("id", existing_app["id"])
            .execute()
        )
    else:
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
        "status": result.data[0].get("status", "applied"),
        "message": "Application submitted successfully" if not existing_app else "Match score recalculated",
    }


@router.get("/my-applications")
async def get_my_applications(
    profile_id: str = Depends(get_current_user_id),
):
    """Candidate sees all their applications and current statuses."""
    candidate = (
        supabase.table("candidates")
        .select("id, email")
        .eq("profile_id", profile_id)
        .limit(1)
        .execute()
    )
    if not candidate.data:
        return {"applications": []}

    candidate_row = candidate.data[0]
    candidate_id = candidate_row["id"]
    candidate_email = (candidate_row.get("email") or "").lower().strip()

    result = (
        supabase.table("jd_applications")
        .select("*, jd_posts(title, department, location)")
        .eq("candidate_id", candidate_id)
        .order("applied_at", desc=True)
        .execute()
    )
    applications = result.data or []

    jd_ids = [app["jd_id"] for app in applications if app.get("jd_id")]
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

    completed_session_ids = [session["id"] for session in completed_by_jd.values() if session.get("id")]
    feedback_session_ids = set()
    if completed_session_ids:
        feedback_rows = (
            supabase.table("candidate_feedback")
            .select("session_id")
            .in_("session_id", completed_session_ids)
            .execute()
        )
        feedback_session_ids = {
            row["session_id"]
            for row in (feedback_rows.data or [])
            if row.get("session_id")
        }

    status_labels = {
        "applied": "Applied",
        "shortlisted": "Shortlisted",
        "invited": "Invited to screen",
        "rejected": "Not selected",
    }
    for app in applications:
        completed_session = completed_by_jd.get(app.get("jd_id"))
        if completed_session:
            app["screening_completed"] = True
            app["completed_at"] = completed_session.get("created_at")
            app["display_status"] = "Completed screening"
            app["feedback_available"] = completed_session.get("id") in feedback_session_ids
        else:
            app["screening_completed"] = False
            app["completed_at"] = None
            app["display_status"] = status_labels.get(app.get("status"), app.get("status"))
            app["feedback_available"] = False

    return {"applications": applications}


@router.get("/my-invites")
async def get_my_invites(
    client=Depends(get_authed_client),
    profile_id: str = Depends(get_current_user_id),
):
    """Candidate sees all screening invites sent by recruiters.

    Three-stage candidate lookup:
      1. candidates.profile_id = auth.uid()              (fast path)
      2. candidates.email      = auth user email         (email fallback)
      3. screening_invites.candidate_email = auth email  (last-resort — recruiter-added)

    Auto-links profile_id on methods 2 & 3 so future calls use method 1.
    Uses the authed client for the profiles lookup so JWT-based RLS allows
    reading the caller's own profile even when no service-role key is set.
    """
    # ── Resolve email via authed PostgREST client (JWT → RLS allows own profile) ─
    try:
        profile_row = client.table("profiles") \
            .select("email") \
            .eq("id", profile_id) \
            .single() \
            .execute()
    except Exception as exc:
        error_text = str(exc).lower()
        if "jwt" in error_text or "token" in error_text or "expired" in error_text or "unauthorized" in error_text:
            raise HTTPException(status_code=401, detail="Session expired. Please login again.")
        raise
    user_email = ((profile_row.data or {}).get("email") or "").lower().strip()

    print(f"DEBUG [my-invites] profile_id={profile_id!r}  user_email={user_email!r}")

    # ── Method 1: profile_id direct match ────────────────────────────────────
    candidate_id: str | None = None

    by_profile = supabase.table("candidates") \
        .select("id") \
        .eq("profile_id", profile_id) \
        .limit(1).execute()
    print(f"DEBUG [my-invites] Method 1 (profile_id): {by_profile.data}")
    if by_profile.data:
        candidate_id = by_profile.data[0]["id"]

    # ── Method 2: email fallback ─────────────────────────────────────────────
    if not candidate_id and user_email:
        by_email = supabase.table("candidates") \
            .select("id, profile_id") \
            .eq("email", user_email) \
            .limit(1).execute()
        print(f"DEBUG [my-invites] Method 2 (email): {by_email.data}")
        if by_email.data:
            candidate_id = by_email.data[0]["id"]
            # Auto-link profile_id so the next call uses Method 1
            if not by_email.data[0].get("profile_id"):
                supabase.table("candidates") \
                    .update({"profile_id": profile_id}) \
                    .eq("id", candidate_id) \
                    .execute()
                print(f"DEBUG [my-invites] Auto-linked profile_id → candidate {candidate_id} (via email)")

    # ── Method 3: look up candidate_id directly from screening_invites ───────
    if not candidate_id and user_email:
        inv_lookup = supabase.table("screening_invites") \
            .select("candidate_id") \
            .ilike("candidate_email", user_email) \
            .limit(1).execute()
        print(f"DEBUG [my-invites] Method 3 (invite.candidate_email): {inv_lookup.data}")
        if inv_lookup.data:
            candidate_id = inv_lookup.data[0]["candidate_id"]
            # Auto-link so the next call uses Method 1
            supabase.table("candidates") \
                .update({"profile_id": profile_id}) \
                .eq("id", candidate_id) \
                .execute()
            print(f"DEBUG [my-invites] Auto-linked profile_id → candidate {candidate_id} (via invite.candidate_email)")

    if not candidate_id:
        print(f"DEBUG [my-invites] No candidate record found for profile_id={profile_id!r} email={user_email!r}")
        return {"invites": [], "debug": "no candidate record found"}

    print(f"DEBUG [my-invites] Resolved candidate_id={candidate_id}")

    # ── Fetch invites ─────────────────────────────────────────────────────────
    invites_result = supabase.table("screening_invites") \
        .select("id, candidate_id, jd_id, token, status, invited_at, started_at, completed_at") \
        .eq("candidate_id", candidate_id) \
        .neq("status", "expired") \
        .order("invited_at", desc=True) \
        .limit(50) \
        .execute()
    invites = invites_result.data or []
    print(f"DEBUG [my-invites] Raw invites for candidate_id={candidate_id}: {len(invites)} rows")

    if not invites:
        return {"invites": [], "candidate_id": candidate_id}

    # Reconcile stale invite rows with completed screening sessions.
    invite_ids = [inv["id"] for inv in invites if inv.get("id")]
    completed_by_invite = {}
    if invite_ids:
        completed_sessions = (
            supabase.table("screening_sessions")
            .select("id, invite_id, status, created_at")
            .in_("invite_id", invite_ids)
            .eq("status", "completed")
            .order("created_at", desc=True)
            .execute()
        )
        for session in completed_sessions.data or []:
            invite_id = session.get("invite_id")
            if invite_id and invite_id not in completed_by_invite:
                completed_by_invite[invite_id] = session

    for inv in invites:
        completed_session = completed_by_invite.get(inv.get("id"))
        if completed_session:
            inv["status"] = "completed"
            inv["screening_completed"] = True
            inv["completed_at"] = inv.get("completed_at") or completed_session.get("created_at")
            inv["completed_session_id"] = completed_session.get("id")
        else:
            inv["screening_completed"] = inv.get("status") == "completed"

    # ── Enrich with JD + company data (separate lookup — jd_posts→profiles FK may not exist) ──
    jd_ids = list({inv["jd_id"] for inv in invites if inv.get("jd_id")})
    jd_map: dict = {}
    if jd_ids:
        jd_result = supabase.table("jd_posts") \
            .select("id, title, department, location, recruiter_id") \
            .in_("id", jd_ids) \
            .execute()
        jds = jd_result.data or []

        recruiter_ids = list({j["recruiter_id"] for j in jds if j.get("recruiter_id")})
        profile_map: dict = {}
        if recruiter_ids:
            try:
                profiles_resp = supabase.table("profiles") \
                    .select("id, company_name") \
                    .in_("id", recruiter_ids) \
                    .execute()
                profile_map = {
                    p["id"]: p.get("company_name", "")
                    for p in (profiles_resp.data or [])
                }
            except Exception:
                pass

        for jd in jds:
            jd["company_name"] = profile_map.get(jd.get("recruiter_id", ""), "")
            jd_map[jd["id"]] = jd

    for inv in invites:
        inv["jd_posts"] = jd_map.get(inv.get("jd_id"), {})

    return {"invites": invites, "candidate_id": candidate_id}


@router.post("/my-invites/{invite_id}/refresh-token")
async def refresh_invite_token(
    invite_id: str,
    client=Depends(get_authed_client),
):
    """
    Returns the current invite token. Returns 200 even on error
    so the frontend stops retrying and just navigates with existing token.
    """
    try:
        print(f"[refresh-token] invite_id={invite_id}")

        invite = (
            supabase.table("screening_invites")
            .select("id, token, status")
            .eq("id", invite_id)
            .limit(1)
            .execute()
        )

        print(f"[refresh-token] found: {invite.data}")

        if not invite.data:
            return {"token": None, "error": "Invite not found"}

        return {
            "token": invite.data[0]["token"],
            "screening_url": f"/screen/{invite.data[0]['token']}"
        }

    except Exception as e:
        import traceback
        print(f"[refresh-token] ERROR: {str(e)}")
        print(traceback.format_exc())
        # Return 200 with error — prevents frontend infinite retry loop
        return {"token": None, "error": str(e)}


@router.get("/upload-history")
async def get_upload_history(
    client=Depends(get_authed_client),
):
    """Returns the candidate's resume analysis history from resume_analyses table."""
    try:
        user = client.auth.get_user()
        profile_id = user.user.id

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
            supabase.table("resume_analyses")
            .select("id, created_at, version, scorecard_json")
            .eq("candidate_id", candidate.data[0]["id"])
            .order("created_at", desc=True)
            .limit(10)
            .execute()
        )

        uploads = [
            {
                "id": r["id"],
                "date": r["created_at"][:10],
                "version": r.get("version", 1),
                "grade": (r.get("scorecard_json") or {}).get("overall_grade", "N/A"),
            }
            for r in (result.data or [])
        ]
        return {"uploads": uploads}

    except Exception as e:
        print(f"[upload-history] Error: {e}")
        return {"uploads": []}


# ── Parameterised route — must stay last ─────────────────────────────────────

@router.get("/{candidate_id}")
async def get_candidate(candidate_id: str):
    response = supabase.table("candidates").select("*").eq("id", candidate_id).execute()
    if not response.data:
        raise HTTPException(status_code=404, detail="Candidate not found")
    return {"success": True, "data": response.data[0], "message": "Candidate retrieved successfully"}
