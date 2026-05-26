from app.services.llm import call_claude
from app.services.utils import (
    truncate_resume, truncate_jd,
    get_cached_resume_analysis, safe_json_parse,
    MAX_TOKENS,
)
from app.database import get_svc_client

_DEFAULT_RESULT = {
    "overall_grade": "F",
    "overall_summary": "Analysis failed — please try again.",
    "scores": {
        "jd_match": 0,
        "ats_score": 0,
        "impact_score": 0,
        "language_score": 0,
        "structure_score": 0,
    },
    "weak_bullets": [],
    "coaching_tips": [],
    "missing_keywords": [],
}

_SYSTEM_PROMPT = """Expert resume coach. Analyse the resume against the job description. Return ONLY valid JSON, no markdown, no backticks.

Scorecard dimensions (score 0-100 each):
- jd_match: keyword and semantic alignment with JD
- ats_score: ATS-friendliness — formatting, headers, keyword density
- impact_score: % of bullet points that have quantified outcomes
- language_score: strength of action verbs, absence of passive voice
- structure_score: completeness of sections, logical ordering

Weak bullets: find up to 4 bullet points from the resume that are vague, passive, or lack numbers. For each provide the original text and a rewritten version that is stronger, more specific, and ideally quantified.

Coaching tips: 3 short actionable tips specific to this candidate's gaps vs this JD.

Overall grade: A, B, C, D or F based on total readiness for this specific role.

JSON structure:
{
  "overall_grade": "A|B|C|D|F",
  "overall_summary": "2 sentence summary",
  "scores": {
    "jd_match": 0-100,
    "ats_score": 0-100,
    "impact_score": 0-100,
    "language_score": 0-100,
    "structure_score": 0-100
  },
  "weak_bullets": [
    { "original": "string", "rewritten": "string" }
  ],
  "coaching_tips": ["tip1", "tip2", "tip3"],
  "missing_keywords": ["keyword1", "keyword2"]
}"""


async def analyse_resume(resume_text: str, jd_text: str, candidate_name: str) -> dict:
    user_message = (
        f"Candidate: {candidate_name}\n"
        f"JD (truncated): {truncate_jd(jd_text)}\n"
        f"Resume (truncated): {truncate_resume(resume_text)}"
    )
    messages = [{"role": "user", "content": user_message}]
    try:
        result = await call_claude(
            _SYSTEM_PROMPT,
            messages,
            max_tokens=MAX_TOKENS["resume_analysis"],
            model="claude-haiku-4-5-20251001",
        )
        parsed = safe_json_parse(result, fallback={})
        if not parsed or "scores" not in parsed:
            return _DEFAULT_RESULT.copy()
        return parsed
    except Exception:
        return _DEFAULT_RESULT.copy()


def get_cached_analysis(candidate_id: str, jd_id: str):
    try:
        result = (
            get_svc_client().table("resume_analyses")
            .select("*")
            .eq("candidate_id", candidate_id)
            .eq("jd_id", jd_id)
            .order("version", desc=True)
            .limit(1)
            .execute()
        )
        return result.data[0] if result.data else None
    except Exception:
        return None


def save_analysis(
    candidate_id: str, jd_id: str, scorecard_json: dict, rewrites_json: list
) -> dict:
    db = get_svc_client()
    version_res = (
        db.table("resume_analyses")
        .select("version")
        .eq("candidate_id", candidate_id)
        .eq("jd_id", jd_id)
        .order("version", desc=True)
        .limit(1)
        .execute()
    )
    current_version = version_res.data[0]["version"] if version_res.data else 0
    new_version = current_version + 1

    row = db.table("resume_analyses").insert({
        "candidate_id": candidate_id,
        "jd_id": jd_id,
        "scorecard_json": scorecard_json,
        "rewrites_json": rewrites_json,
        "version": new_version,
    }).execute()

    return row.data[0] if row.data else {}
