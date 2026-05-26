from app.database import supabase
from app.services.llm import call_claude
from app.services.utils import (
    MAX_TOKENS,
    get_cached_feedback,
    get_job_recommendations,
    safe_json_parse,
)


DIMS = ["english_proficiency", "answer_quality", "soft_skills", "job_fit"]

_FEEDBACK_SYSTEM_PROMPT = """You generate concise, candidate-facing interview feedback.
Return ONLY valid JSON, no markdown, no backticks.

{
  "overall_message": "2-sentence encouraging summary of their performance",
  "dimension_feedback": {
    "english_proficiency": "one specific sentence",
    "answer_quality": "one specific sentence",
    "soft_skills": "one specific sentence",
    "job_fit": "one specific sentence"
  },
  "strengths": [
    "specific strength 1",
    "specific strength 2"
  ],
  "improvement_areas": [
    {
      "area": "skill name",
      "current": "what they did",
      "suggestion": "specific actionable improvement"
    }
  ],
  "coaching_tips": [
    "Tip 1 - specific and actionable",
    "Tip 2 - specific and actionable",
    "Tip 3 - specific and actionable"
  ],
  "next_steps": "one sentence on what to do before next interview"
}"""


def _score(avg_scores: dict, dim: str) -> float:
    try:
        return float((avg_scores or {}).get(dim, 0) or 0)
    except (TypeError, ValueError):
        return 0.0


def calculate_average_scores(scores_list: list) -> dict:
    averages = {}
    for dim in DIMS:
        values = []
        for item in scores_list or []:
            value = ((item or {}).get("scores") or {}).get(dim)
            if value is not None:
                try:
                    values.append(float(value))
                except (TypeError, ValueError):
                    pass
        averages[dim] = round(sum(values) / len(values), 1) if values else 0
    return averages


def _weakest_dimensions(avg_scores: dict) -> list:
    return [
        dim
        for dim, _ in sorted(
            ((dim, _score(avg_scores, dim)) for dim in DIMS),
            key=lambda item: item[1],
        )[:2]
    ]


def _fallback_feedback(jd_title: str, avg_scores: dict, overall_score: float) -> dict:
    weakest = _weakest_dimensions(avg_scores)
    strongest = max(DIMS, key=lambda dim: _score(avg_scores, dim))
    return {
        "overall_message": (
            f"You completed the screening for {jd_title} with an overall score of "
            f"{round(overall_score or 0)}/100. Keep building on your strongest answers "
            "and use the notes below to prepare for the next interview."
        ),
        "dimension_feedback": {
            dim: f"Your {dim.replace('_', ' ')} score was {round(_score(avg_scores, dim))}/100."
            for dim in DIMS
        },
        "strengths": [
            f"Strongest interview dimension: {strongest.replace('_', ' ')}.",
            "Completed the full AI screening process.",
        ],
        "improvement_areas": [
            {
                "area": dim.replace("_", " "),
                "current": f"Current score: {round(_score(avg_scores, dim))}/100.",
                "suggestion": "Prepare one concise STAR example with a clear result before your next interview.",
            }
            for dim in weakest
        ],
        "coaching_tips": [
            "Use the STAR structure for behavioural answers.",
            "Anchor each answer in one concrete example and measurable outcome.",
            "Practise a 60-90 second answer for why this role fits your goals.",
        ],
        "next_steps": "Review your weakest areas and prepare two role-specific examples before the next interview.",
    }


def _normalise_feedback(feedback: dict, jd_title: str, avg_scores: dict, overall_score: float) -> dict:
    fallback = _fallback_feedback(jd_title, avg_scores, overall_score)
    data = feedback if isinstance(feedback, dict) else {}
    dimension_feedback = data.get("dimension_feedback") if isinstance(data.get("dimension_feedback"), dict) else {}
    return {
        "overall_message": data.get("overall_message") or fallback["overall_message"],
        "dimension_feedback": {
            dim: dimension_feedback.get(dim) or fallback["dimension_feedback"][dim]
            for dim in DIMS
        },
        "strengths": data.get("strengths") if isinstance(data.get("strengths"), list) else fallback["strengths"],
        "improvement_areas": (
            data.get("improvement_areas")
            if isinstance(data.get("improvement_areas"), list)
            else fallback["improvement_areas"]
        ),
        "coaching_tips": (
            data.get("coaching_tips")
            if isinstance(data.get("coaching_tips"), list)
            else fallback["coaching_tips"]
        ),
        "next_steps": data.get("next_steps") or fallback["next_steps"],
    }


def build_cached_feedback_shape(
    session_id: str,
    candidate_id: str | None,
    jd_id: str | None,
    jd_title: str,
    avg_scores: dict,
    overall_score: float,
    recommended_jds: list | None = None,
) -> dict:
    feedback = _normalise_feedback({}, jd_title, avg_scores, overall_score)
    return {
        "id": f"generated-{session_id}",
        "session_id": session_id,
        "candidate_id": candidate_id,
        "overall_score": overall_score or 0,
        "overall_message": feedback["overall_message"],
        "dimension_feedback": feedback["dimension_feedback"],
        "strengths": feedback["strengths"],
        "improvement_areas": feedback["improvement_areas"],
        "coaching_tips": feedback["coaching_tips"],
        "next_steps": feedback["next_steps"],
        "recommended_jds": recommended_jds or [],
        "screening_sessions": {
            "jd_id": jd_id,
            "jd_posts": {"title": jd_title},
        },
    }


async def generate_candidate_feedback(
    session_id: str,
    candidate_id: str,
    jd_id: str,
    jd_title: str,
    avg_scores: dict,
    overall_score: float,
    scores_list: list,
    use_llm: bool = True,
) -> dict:
    cached = get_cached_feedback(session_id)
    if cached:
        return cached

    recommendations = get_job_recommendations(
        candidate_id=candidate_id,
        exclude_jd_id=jd_id,
        limit=3,
    ) if candidate_id else []
    weakest = _weakest_dimensions(avg_scores)
    question_count = len(scores_list or [])

    parsed = {}
    if use_llm:
        user_message = (
            f"JD title: {jd_title}\n"
            f"Overall score: {round(overall_score or 0, 1)}/100\n"
            f"Average dimension scores: "
            f"english_proficiency={_score(avg_scores, 'english_proficiency')}, "
            f"answer_quality={_score(avg_scores, 'answer_quality')}, "
            f"soft_skills={_score(avg_scores, 'soft_skills')}, "
            f"job_fit={_score(avg_scores, 'job_fit')}\n"
            f"Weakest areas: {', '.join(weakest)}\n"
            f"Number of answered questions: {question_count}"
        )

        try:
            raw = await call_claude(
                _FEEDBACK_SYSTEM_PROMPT,
                [{"role": "user", "content": user_message}],
                max_tokens=MAX_TOKENS["feedback_gen"],
                model="claude-haiku-4-5-20251001",
            )
            parsed = safe_json_parse(raw, fallback={})
        except Exception as e:
            print(f"[feedback] Claude generation failed: {e}")

    feedback = _normalise_feedback(parsed, jd_title, avg_scores, overall_score)
    row = {
        "session_id": session_id,
        "candidate_id": candidate_id,
        "overall_score": overall_score or 0,
        "overall_message": feedback["overall_message"],
        "dimension_feedback": feedback["dimension_feedback"],
        "strengths": feedback["strengths"],
        "improvement_areas": feedback["improvement_areas"],
        "coaching_tips": feedback["coaching_tips"],
        "next_steps": feedback["next_steps"],
        "recommended_jds": recommendations,
    }

    try:
        saved = supabase.table("candidate_feedback").insert(row).execute()
        if saved.data:
            return saved.data[0]
    except Exception as e:
        print(f"[feedback] Save failed for session={session_id}: {e}")

    return row
