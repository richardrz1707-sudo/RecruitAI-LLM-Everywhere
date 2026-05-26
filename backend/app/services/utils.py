"""
Shared utilities for credit-efficient Claude API usage.
All truncation, caching, and token management lives here.
Import these helpers in every service that calls Claude.
"""
import json
from app.database import supabase


# ── Rule 4: Hard input truncation ─────────────────────────────────────
RESUME_MAX_CHARS = 1500   # ~375 tokens
JD_MAX_CHARS     = 1000   # ~250 tokens
ANSWER_MAX_CHARS = 500    # ~125 tokens
COVER_LETTER_MAX = 1200   # ~300 tokens


def truncate_resume(text: str) -> str:
    """Truncate resume to RESUME_MAX_CHARS. Always call before building any prompt."""
    if not text:
        return ""
    return text[:RESUME_MAX_CHARS]


def truncate_jd(text: str) -> str:
    """Truncate JD text to JD_MAX_CHARS. Always call before building any prompt."""
    if not text:
        return ""
    return text[:JD_MAX_CHARS]


def truncate_answer(text: str) -> str:
    """Truncate answer text to ANSWER_MAX_CHARS before evaluation."""
    if not text:
        return ""
    return text[:ANSWER_MAX_CHARS]


# ── Rule 5: max_tokens per call type ──────────────────────────────────
MAX_TOKENS = {
    "jd_parse":        400,
    "resume_analysis": 800,
    "match_score":     500,
    "question_gen":    500,
    "answer_eval":     350,
    "report_gen":      600,
    "feedback_gen":    500,
    "cover_letter":    700,
}


# ── Rule 1: Cache check helpers ───────────────────────────────────────

def get_cached_jd_parse(jd_id: str) -> dict | None:
    """Return cached parsed JD JSON or None."""
    try:
        result = (
            supabase.table("jd_posts")
            .select("parsed_json")
            .eq("id", jd_id)
            .single()
            .execute()
        )
        if result.data and result.data.get("parsed_json"):
            return result.data["parsed_json"]
    except Exception:
        pass
    return None


def get_cached_resume_analysis(candidate_id: str, jd_id: str) -> dict | None:
    """Return cached resume analysis or None."""
    try:
        result = (
            supabase.table("resume_analyses")
            .select("scorecard_json, rewrites_json, version")
            .eq("candidate_id", candidate_id)
            .eq("jd_id", jd_id)
            .order("version", desc=True)
            .limit(1)
            .execute()
        )
        if result.data:
            return result.data[0]
    except Exception:
        pass
    return None


def get_cached_match_score(candidate_id: str, jd_id: str) -> dict | None:
    """Return cached match score or None."""
    try:
        result = (
            supabase.table("match_scores")
            .select("score_json, total_score")
            .eq("candidate_id", candidate_id)
            .eq("jd_id", jd_id)
            .limit(1)
            .execute()
        )
        if result.data:
            return result.data[0]
    except Exception:
        pass
    return None


def get_cached_questions(candidate_id: str, jd_id: str) -> list | None:
    """Return cached question set or None."""
    try:
        result = (
            supabase.table("interview_questions")
            .select("questions_json")
            .eq("candidate_id", candidate_id)
            .eq("jd_id", jd_id)
            .limit(1)
            .execute()
        )
        if result.data:
            return result.data[0]["questions_json"]
    except Exception:
        pass
    return None


def get_cached_report(session_id: str) -> dict | None:
    """Return cached session report or None."""
    try:
        result = (
            supabase.table("screening_sessions")
            .select("report_json")
            .eq("id", session_id)
            .single()
            .execute()
        )
        if result.data and result.data.get("report_json"):
            return result.data["report_json"]
    except Exception:
        pass
    return None


def get_cached_feedback(session_id: str) -> dict | None:
    """Return cached candidate feedback or None."""
    try:
        result = (
            supabase.table("candidate_feedback")
            .select("*")
            .eq("session_id", session_id)
            .limit(1)
            .execute()
        )
        if result.data:
            return result.data[0]
    except Exception:
        pass
    return None


# ── Rule 3: Job recommendations from existing match scores ────────────

def get_job_recommendations(
    candidate_id: str,
    exclude_jd_id: str = None,
    limit: int = 3,
) -> list:
    """
    Get top matching JDs for a candidate using EXISTING match scores.
    Zero Claude calls — reads from match_scores table only.
    Returns list of {jd_id, jd_title, total_score, match_reason}.
    """
    try:
        result = (
            supabase.table("match_scores")
            .select("jd_id, total_score, score_json, jd_posts(title, department, location)")
            .eq("candidate_id", candidate_id)
            .order("total_score", desc=True)
            .limit(limit + 2)  # fetch extra in case some are excluded
            .execute()
        )
        recommendations = []
        for row in result.data:
            if exclude_jd_id and row["jd_id"] == exclude_jd_id:
                continue
            jd_info = row.get("jd_posts") or {}
            score_json = row.get("score_json") or {}
            recommendations.append({
                "jd_id": row["jd_id"],
                "jd_title": jd_info.get("title", "Unknown role"),
                "department": jd_info.get("department", ""),
                "location": jd_info.get("location", ""),
                "match_score": row["total_score"],
                "match_reason": score_json.get("overall_summary", ""),
            })
            if len(recommendations) >= limit:
                break
        return recommendations
    except Exception as e:
        print(f"Job recommendation lookup failed: {e}")
        return []


# ── Rule 6: Cover letter rate limiting ────────────────────────────────

def get_cached_cover_letter(candidate_id: str, jd_id: str) -> str | None:
    """
    Return cached cover letter text or None.
    Cover letters are cached — candidates cannot regenerate indefinitely.
    """
    try:
        result = (
            supabase.table("resume_analyses")
            .select("cover_letter_text")
            .eq("candidate_id", candidate_id)
            .eq("jd_id", jd_id)
            .not_.is_("cover_letter_text", "null")
            .limit(1)
            .execute()
        )
        if result.data and result.data[0].get("cover_letter_text"):
            return result.data[0]["cover_letter_text"]
    except Exception:
        pass
    return None


# ── Safe JSON parse helper ────────────────────────────────────────────

def safe_json_parse(text: str, fallback=None):
    """
    Safely parse JSON from Claude response.
    Strips markdown code fences before parsing.
    Returns fallback on any error.
    """
    if fallback is None:
        fallback = {}
    try:
        clean = text.strip()
        clean = clean.replace("```json", "").replace("```", "").strip()
        return json.loads(clean)
    except Exception as e:
        print(f"JSON parse error: {e} — text was: {text[:200]}")
        return fallback
