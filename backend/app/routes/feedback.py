from fastapi import APIRouter, Depends, HTTPException

from app.database import get_current_user_id, supabase
from app.services.feedback_service import (
    build_cached_feedback_shape,
    calculate_average_scores,
    generate_candidate_feedback,
)
from app.services.utils import get_cached_feedback

router = APIRouter(prefix="/feedback", tags=["feedback"])


def _candidate_ids_for_profile(profile_id: str) -> list:
    candidate_ids = set()
    by_profile = (
        supabase.table("candidates")
        .select("id")
        .eq("profile_id", profile_id)
        .execute()
    )
    for candidate in by_profile.data or []:
        candidate_ids.add(candidate["id"])

    profile = (
        supabase.table("profiles")
        .select("email")
        .eq("id", profile_id)
        .single()
        .execute()
    )
    email = (profile.data or {}).get("email")
    if email:
        by_email = (
            supabase.table("candidates")
            .select("id")
            .eq("email", email)
            .execute()
        )
        for candidate in by_email.data or []:
            candidate_ids.add(candidate["id"])

    return list(candidate_ids)


def _profile_email(profile_id: str) -> str:
    profile = (
        supabase.table("profiles")
        .select("email")
        .eq("id", profile_id)
        .single()
        .execute()
    )
    return ((profile.data or {}).get("email") or "").lower().strip()


def _candidate_owns_feedback(feedback: dict, profile_id: str) -> bool:
    candidate_ids = _candidate_ids_for_profile(profile_id)
    return bool(feedback.get("candidate_id") in candidate_ids)


def _enrich_feedback_rows(rows: list) -> list:
    for row in rows:
        session = (
            supabase.table("screening_sessions")
            .select("jd_id, created_at")
            .eq("id", row["session_id"])
            .limit(1)
            .execute()
        )
        session_row = session.data[0] if session.data else {}
        jd = {}
        if session_row.get("jd_id"):
            jd_result = (
                supabase.table("jd_posts")
                .select("title, department, location")
                .eq("id", session_row["jd_id"])
                .limit(1)
                .execute()
            )
            jd = jd_result.data[0] if jd_result.data else {}
        row["screening_sessions"] = {
            "jd_id": session_row.get("jd_id"),
            "created_at": session_row.get("created_at"),
            "jd_posts": jd,
        }
    return rows


async def _backfill_missing_feedback(candidate_ids: list, email: str) -> dict:
    if not candidate_ids and not email:
        return {"session_ids": [], "generated_rows": [], "completed_count": 0}

    query = (
        supabase.table("screening_sessions")
        .select("id, jd_id, candidate_name, candidate_email, scores_json, report_json")
        .eq("status", "completed")
        .order("created_at", desc=True)
        .limit(5)
    )
    if email:
        query = query.eq("candidate_email", email)
    sessions = query.execute()
    session_ids = [session["id"] for session in sessions.data or []]
    if not session_ids:
        return {"session_ids": [], "generated_rows": [], "completed_count": 0}

    existing = (
        supabase.table("candidate_feedback")
        .select("session_id")
        .in_("session_id", session_ids)
        .execute()
    )
    existing_session_ids = {
        row["session_id"]
        for row in (existing.data or [])
        if row.get("session_id")
    }

    generated_rows = []
    for session in sessions.data or []:
        if session["id"] in existing_session_ids:
            continue
        candidate_id = None
        session_email = (session.get("candidate_email") or "").lower().strip()
        if session_email:
            candidate = (
                supabase.table("candidates")
                .select("id")
                .eq("email", session_email)
                .limit(1)
                .execute()
            )
            if candidate.data:
                candidate_id = candidate.data[0]["id"]
        if not candidate_id and candidate_ids:
            candidate_id = candidate_ids[0]
        if not candidate_id:
            continue

        scores = session.get("scores_json") or []
        avg_scores = calculate_average_scores(scores)
        report = session.get("report_json") or {}
        jd_title = "this role"
        if session.get("jd_id"):
            jd_result = (
                supabase.table("jd_posts")
                .select("title")
                .eq("id", session["jd_id"])
                .limit(1)
                .execute()
            )
            if jd_result.data:
                jd_title = jd_result.data[0].get("title") or jd_title
        try:
            feedback = await generate_candidate_feedback(
                session_id=session["id"],
                candidate_id=candidate_id,
                jd_id=session.get("jd_id"),
                jd_title=jd_title,
                avg_scores=avg_scores,
                overall_score=report.get("overall_score") or round(sum(avg_scores.values()) / 4),
                scores_list=scores,
                use_llm=False,
            )
            if feedback:
                generated_rows.append(feedback)
        except Exception as e:
            print(f"[feedback] Backfill skipped session={session['id']}: {e}")
    return {
        "session_ids": session_ids,
        "generated_rows": generated_rows,
        "completed_count": len(session_ids),
    }


@router.get("/session/{session_id}")
async def get_session_feedback(
    session_id: str,
    profile_id: str = Depends(get_current_user_id),
):
    cached = get_cached_feedback(session_id)
    if cached:
        if not _candidate_owns_feedback(cached, profile_id):
            raise HTTPException(status_code=404, detail="Feedback not found")
        return cached

    session = (
        supabase.table("screening_sessions")
        .select("id, status")
        .eq("id", session_id)
        .limit(1)
        .execute()
    )
    if not session.data:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.data[0].get("status") != "completed":
        raise HTTPException(status_code=400, detail="Screening session is not completed yet")
    raise HTTPException(
        status_code=404,
        detail="Feedback has not been generated for this completed session",
    )


@router.get("/my-history")
async def get_my_feedback_history(
    profile_id: str = Depends(get_current_user_id),
):
    candidate_ids = _candidate_ids_for_profile(profile_id)
    if not candidate_ids:
        email = _profile_email(profile_id)
        if not email:
            return {"feedback_history": []}
        by_email = (
            supabase.table("candidates")
            .select("id")
            .eq("email", email)
            .execute()
        )
        candidate_ids = [candidate["id"] for candidate in by_email.data or []]
        if not candidate_ids:
            created = (
                supabase.table("candidates")
                .insert({"profile_id": profile_id, "name": email, "email": email})
                .execute()
            )
            candidate_ids = [created.data[0]["id"]] if created.data else []
        if not candidate_ids:
            return {"feedback_history": []}

    backfill = await _backfill_missing_feedback(candidate_ids, _profile_email(profile_id))
    session_ids = backfill["session_ids"]

    try:
        rows = list(backfill["generated_rows"])
        if candidate_ids:
            result = (
                supabase.table("candidate_feedback")
                .select("*")
                .in_("candidate_id", candidate_ids)
                .order("created_at", desc=True)
                .execute()
            )
            rows.extend(result.data or [])
        if session_ids:
            by_session = (
                supabase.table("candidate_feedback")
                .select("*")
                .in_("session_id", session_ids)
                .order("created_at", desc=True)
                .execute()
            )
            rows.extend(by_session.data or [])
        seen = set()
        unique_rows = []
        for row in rows:
            key = row.get("session_id") or row.get("id")
            if key in seen:
                continue
            seen.add(key)
            unique_rows.append(row)
        return {
            "feedback_history": _enrich_feedback_rows(unique_rows),
            "completed_screenings_found": backfill["completed_count"],
        }
    except Exception as e:
        print(f"[feedback] History lookup failed: {e}")

    result = (
        supabase.table("candidate_feedback")
        .select("*")
        .in_("candidate_id", candidate_ids)
        .order("created_at", desc=True)
        .execute()
    )
    return {"feedback_history": _enrich_feedback_rows(result.data or [])}


@router.get("/history/by-email/{email}")
async def get_feedback_history_by_email(
    email: str,
    _profile_id: str = Depends(get_current_user_id),
):
    normalised = email.lower().strip()
    if not normalised:
        return {"feedback_history": []}

    sessions = (
        supabase.table("screening_sessions")
        .select("id, jd_id, candidate_name, candidate_email, scores_json, report_json, created_at")
        .eq("candidate_email", normalised)
        .eq("status", "completed")
        .order("created_at", desc=True)
        .limit(20)
        .execute()
    )
    completed_sessions = sessions.data or []
    if not completed_sessions:
        return {"feedback_history": []}

    session_ids = [session["id"] for session in completed_sessions]
    feedback_result = (
        supabase.table("candidate_feedback")
        .select("*")
        .in_("session_id", session_ids)
        .execute()
    )
    feedback_by_session = {
        row["session_id"]: row
        for row in feedback_result.data or []
        if row.get("session_id")
    }

    jd_ids = list({session["jd_id"] for session in completed_sessions if session.get("jd_id")})
    jd_titles = {}
    if jd_ids:
        jd_result = (
            supabase.table("jd_posts")
            .select("id, title, department, location")
            .in_("id", jd_ids)
            .execute()
        )
        jd_titles = {jd["id"]: jd for jd in jd_result.data or []}

    rows = []
    for session in completed_sessions:
        existing = feedback_by_session.get(session["id"])
        jd = jd_titles.get(session.get("jd_id"), {})
        if existing:
            existing["screening_sessions"] = {
                "jd_id": session.get("jd_id"),
                "created_at": session.get("created_at"),
                "jd_posts": jd,
            }
            rows.append(existing)
            continue

        scores = session.get("scores_json") or []
        avg_scores = calculate_average_scores(scores)
        report = session.get("report_json") or {}
        overall_score = report.get("overall_score") or round(sum(avg_scores.values()) / 4)
        row = build_cached_feedback_shape(
            session_id=session["id"],
            candidate_id=None,
            jd_id=session.get("jd_id"),
            jd_title=jd.get("title") or "this role",
            avg_scores=avg_scores,
            overall_score=overall_score,
        )
        row["created_at"] = session.get("created_at")
        row["screening_sessions"]["created_at"] = session.get("created_at")
        row["screening_sessions"]["jd_posts"] = jd or {"title": jd.get("title") or "this role"}
        rows.append(row)

    return {
        "feedback_history": rows,
        "completed_screenings_found": len(completed_sessions),
    }
