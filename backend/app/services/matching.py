import json
import asyncio
import re
from app.services.llm import call_claude

_DEFAULT_WEIGHTS = {
    "hard_skills_match": 0.30,
    "experience_fit": 0.25,
    "education_alignment": 0.10,
    "soft_skills_signals": 0.15,
    "industry_relevance": 0.12,
    "career_trajectory": 0.08,
}

_DEFAULT_SCORE_RESPONSE = {
    "hard_skills_match": {"score": 0, "reason": "Unable to evaluate.", "matched": [], "gaps": []},
    "experience_fit": {"score": 0, "reason": "Unable to evaluate.", "matched": [], "gaps": []},
    "education_alignment": {"score": 0, "reason": "Unable to evaluate.", "matched": [], "gaps": []},
    "soft_skills_signals": {"score": 0, "reason": "Unable to evaluate.", "matched": [], "gaps": []},
    "industry_relevance": {"score": 0, "reason": "Unable to evaluate.", "matched": [], "gaps": []},
    "career_trajectory": {"score": 0, "reason": "Unable to evaluate.", "matched": [], "gaps": []},
    "overall_summary": "Unable to score candidate due to a processing error.",
    "recommendation": "weak_match",
}

_DIMENSIONS = [
    "hard_skills_match",
    "experience_fit",
    "education_alignment",
    "soft_skills_signals",
    "industry_relevance",
    "career_trajectory",
]


def _extract_json(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        inner = lines[1:] if lines[0].startswith("```") else lines
        if inner and inner[-1].strip() == "```":
            inner = inner[:-1]
        text = "\n".join(inner).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                pass
    return {}


async def parse_jd(jd_text: str) -> dict:
    system_prompt = (
        "You are an expert job description analyst. Extract structured requirements from the job description provided.\n"
        "Return ONLY a valid JSON object with no markdown, no backticks, no explanation. Use this exact structure:\n"
        '{\n'
        '  "role_title": "string",\n'
        '  "required_skills": ["skill1", "skill2"],\n'
        '  "nice_to_have_skills": ["skill1", "skill2"],\n'
        '  "min_years_experience": number,\n'
        '  "education_requirements": "string",\n'
        '  "industry_context": "string",\n'
        '  "seniority_level": "junior|mid|senior|lead",\n'
        '  "soft_skills_needed": ["skill1", "skill2"],\n'
        '  "key_responsibilities": ["responsibility1", "responsibility2"]\n'
        "}"
    )
    messages = [{"role": "user", "content": f"Parse this job description:\n\n{jd_text}"}]
    try:
        result = await call_claude(system_prompt, messages, max_tokens=1000)
        return _extract_json(result)
    except Exception:
        return {}


async def score_candidate(resume_text: str, parsed_jd: dict, candidate_name: str) -> dict:
    system_prompt = (
        "You are a senior technical recruiter with 15 years of experience. Your job is to evaluate candidate "
        "resumes against job requirements fairly and accurately.\n\n"
        "You score candidates across 6 dimensions. For each dimension, provide:\n"
        "- A score from 0 to 100\n"
        "- A one-sentence reason quoting or referencing specific evidence from the resume\n"
        "- A list of matched items (skills, experiences, or signals found)\n"
        "- A list of gaps (what is missing or weak)\n\n"
        "Scoring dimensions:\n"
        "1. hard_skills_match — How well do the candidate's technical skills match the required and nice-to-have skills? "
        'Use semantic understanding — "ReactJS" matches "React". Score required skills higher than nice-to-have.\n'
        "2. experience_fit — Do the years and seniority of experience meet the requirement? Penalise both significant "
        "under and over-qualification.\n"
        "3. education_alignment — How relevant is the candidate's educational background? Consider field relevance, "
        "not just degree level.\n"
        "4. soft_skills_signals — What soft skills are demonstrated through achievements and responsibilities — not "
        'just stated? Leadership inferred from "managed a team of 5" scores higher than just listing "leadership".\n'
        "5. industry_relevance — Has the candidate worked in a similar industry or domain? Direct industry experience "
        "scores highest, adjacent scores medium, unrelated scores low.\n"
        "6. career_trajectory — Is the candidate's career moving toward this role? Consistent upward progression in "
        "relevant areas is a positive signal.\n\n"
        "Return ONLY a valid JSON object with no markdown, no backticks, no explanation. Use this exact structure:\n"
        "{\n"
        '  "hard_skills_match":    { "score": 0-100, "reason": "string", "matched": [], "gaps": [] },\n'
        '  "experience_fit":       { "score": 0-100, "reason": "string", "matched": [], "gaps": [] },\n'
        '  "education_alignment":  { "score": 0-100, "reason": "string", "matched": [], "gaps": [] },\n'
        '  "soft_skills_signals":  { "score": 0-100, "reason": "string", "matched": [], "gaps": [] },\n'
        '  "industry_relevance":   { "score": 0-100, "reason": "string", "matched": [], "gaps": [] },\n'
        '  "career_trajectory":    { "score": 0-100, "reason": "string", "matched": [], "gaps": [] },\n'
        '  "overall_summary": "2-3 sentence plain English summary",\n'
        '  "recommendation": "strong_match|good_match|partial_match|weak_match"\n'
        "}"
    )
    user_message = (
        f"Candidate name: {candidate_name}\n\n"
        f"Job requirements:\n{json.dumps(parsed_jd, indent=2)}\n\n"
        f"Candidate resume:\n{resume_text}"
    )
    messages = [{"role": "user", "content": user_message}]
    try:
        result = await call_claude(system_prompt, messages, max_tokens=2000)
        parsed = _extract_json(result)
        if not parsed or "hard_skills_match" not in parsed:
            return _DEFAULT_SCORE_RESPONSE.copy()
        return parsed
    except Exception:
        return _DEFAULT_SCORE_RESPONSE.copy()


def calculate_weighted_score(score_json: dict, weights: dict = None) -> float:
    w = weights if weights is not None else _DEFAULT_WEIGHTS
    total = sum(
        score_json.get(dim, {}).get("score", 0) * w.get(dim, 0)
        for dim in _DIMENSIONS
    )
    return round(total, 1)


async def rank_candidates(
    candidates: list, jd_text: str, parsed_jd: dict, weights: dict = None
) -> list:
    tasks = [
        score_candidate(c.get("resume_text", ""), parsed_jd, c.get("name", "Unknown"))
        for c in candidates
    ]
    scores = await asyncio.gather(*tasks)

    results = []
    for candidate, score_json in zip(candidates, scores):
        total = calculate_weighted_score(score_json, weights)
        results.append({**candidate, "score_json": score_json, "total_score": total})

    results.sort(key=lambda x: x["total_score"], reverse=True)
    return results
