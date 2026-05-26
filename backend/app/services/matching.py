import json
import re
import asyncio
import traceback
from app.services.llm import call_claude
from app.services.utils import (
    truncate_resume, truncate_jd,
    get_cached_match_score, safe_json_parse,
    MAX_TOKENS,
)

_DEFAULT_WEIGHTS = {
    "hard_skills_match":   0.35,
    "experience_fit":      0.25,
    "education_alignment": 0.10,
    "soft_skills_signals": 0.15,
    "industry_relevance":  0.10,
    "career_trajectory":   0.05,
}


def get_dynamic_weights(parsed_jd: dict) -> dict:
    """
    Returns weights based on what the JD actually prioritises.
    Weights sum to 1.0 but reflect relative importance, not equal split.
    """
    seniority  = (parsed_jd.get("seniority_level") or "mid").lower()
    role_title = (parsed_jd.get("role_title")       or "").lower()

    # Base weights — hard skills always matters most
    weights = {
        "hard_skills_match":   0.35,
        "experience_fit":      0.25,
        "education_alignment": 0.10,
        "soft_skills_signals": 0.15,
        "industry_relevance":  0.10,
        "career_trajectory":   0.05,
    }

    # Senior / lead / manager roles: experience and trajectory matter more
    if seniority in ("senior", "lead", "principal", "manager", "director"):
        weights["hard_skills_match"]   = 0.30
        weights["experience_fit"]      = 0.30
        weights["soft_skills_signals"] = 0.20
        weights["career_trajectory"]   = 0.10
        weights["industry_relevance"]  = 0.07
        weights["education_alignment"] = 0.03

    # Junior / graduate / intern roles: hard skills and education matter more
    elif seniority in ("junior", "graduate", "entry", "intern", "fresh"):
        weights["hard_skills_match"]   = 0.40
        weights["education_alignment"] = 0.20
        weights["experience_fit"]      = 0.15
        weights["soft_skills_signals"] = 0.15
        weights["industry_relevance"]  = 0.05
        weights["career_trajectory"]   = 0.05

    # Technical roles: bump hard skills, trim education
    tech_kw = (
        "engineer", "developer", "data", "software",
        "backend", "frontend", "fullstack", "devops",
        "machine learning", "ai", "cloud",
    )
    if any(kw in role_title for kw in tech_kw):
        weights["hard_skills_match"]   = min(weights["hard_skills_match"]   + 0.05, 0.50)
        weights["education_alignment"] = max(weights["education_alignment"] - 0.05, 0.03)

    # Sales / marketing / people roles: soft skills + industry matter more
    people_kw = (
        "sales", "marketing", "business development",
        "account", "customer", "client", "recruiter",
    )
    if any(kw in role_title for kw in people_kw):
        weights["soft_skills_signals"] = min(weights["soft_skills_signals"] + 0.05, 0.25)
        weights["industry_relevance"]  = min(weights["industry_relevance"]  + 0.05, 0.20)
        weights["hard_skills_match"]   = max(weights["hard_skills_match"]   - 0.05, 0.25)

    # Normalise so weights always sum exactly to 1.0
    total = sum(weights.values())
    return {k: round(v / total, 4) for k, v in weights.items()}

# Used when Claude fails entirely — all zeros so the UI shows something
_ERROR_SCORE_RESPONSE = {
    "hard_skills_match":   {"score": 0, "reason": "Scoring unavailable", "matched": [], "gaps": []},
    "experience_fit":      {"score": 0, "reason": "Scoring unavailable", "matched": [], "gaps": []},
    "education_alignment": {"score": 0, "reason": "Scoring unavailable", "matched": [], "gaps": []},
    "soft_skills_signals": {"score": 0, "reason": "Scoring unavailable", "matched": [], "gaps": []},
    "industry_relevance":  {"score": 0, "reason": "Scoring unavailable", "matched": [], "gaps": []},
    "career_trajectory":   {"score": 0, "reason": "Scoring unavailable", "matched": [], "gaps": []},
    "overall_summary": "Scoring unavailable — please try regenerating.",
    "recommendation": "weak_match",
    "why_this_person": "",
    "profile_signals": [],
    "outreach_draft": "",
}

# Keep backwards-compat alias used by cache-poisoning check
_DEFAULT_SCORE_RESPONSE = _ERROR_SCORE_RESPONSE

_DIMENSIONS = [
    "hard_skills_match",
    "experience_fit",
    "education_alignment",
    "soft_skills_signals",
    "industry_relevance",
    "career_trajectory",
]

_STOPWORDS = {
    "and", "the", "for", "with", "this", "that", "you", "your", "our", "are",
    "will", "have", "has", "from", "job", "role", "work", "team", "candidate",
    "experience", "skills", "ability", "responsibilities", "requirements",
    "preferred", "required", "years", "using", "based", "including", "such",
}


def _keywords(text: str) -> list:
    words = re.findall(r"[a-zA-Z][a-zA-Z0-9+#.-]{2,}", (text or "").lower())
    return [w for w in words if w not in _STOPWORDS]


def _top_terms(text: str, limit: int = 12) -> list:
    counts = {}
    for word in _keywords(text):
        counts[word] = counts.get(word, 0) + 1
    return [word for word, _ in sorted(counts.items(), key=lambda item: item[1], reverse=True)[:limit]]


def _extract_json(raw: str) -> dict:
    """
    Robustly extract the first JSON object from a Claude response.
    Handles markdown fences, leading text, trailing text.
    Returns {} on total failure.
    """
    if not raw:
        return {}
    text = raw.strip()
    # Strip markdown fences
    text = text.replace("```json", "").replace("```", "").strip()
    # Find the outermost { ... }
    start = text.find("{")
    end = text.rfind("}") + 1
    if start == -1 or end <= start:
        print(f"[_extract_json] No JSON object found in: {text[:200]}")
        return {}
    text = text[start:end]
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        print(f"[_extract_json] JSONDecodeError: {e}")
        print(f"[_extract_json] Attempted to parse (first 400 chars): {text[:400]}")
        return {}


def fallback_score_candidate(resume_text: str, jd_text: str, parsed_jd: dict = None) -> dict:
    parsed_jd = parsed_jd or {}
    required = parsed_jd.get("required_skills") or []
    nice = parsed_jd.get("nice_to_have_skills") or []
    jd_terms = [str(item).lower() for item in (required + nice) if item]
    if not jd_terms:
        jd_terms = _top_terms(jd_text)

    resume_lower = (resume_text or "").lower()
    matched = []
    gaps = []
    for term in jd_terms[:12]:
        term_text = str(term).lower().strip()
        if not term_text:
            continue
        if term_text in resume_lower:
            matched.append(term_text)
        else:
            gaps.append(term_text)

    if jd_terms:
        hard_score = round((len(matched) / max(len(jd_terms[:12]), 1)) * 100)
    else:
        jd_set = set(_keywords(jd_text))
        resume_set = set(_keywords(resume_text))
        hard_score = round((len(jd_set & resume_set) / max(len(jd_set), 1)) * 100) if jd_set else 35

    hard_score = max(25, min(85, hard_score))
    resume_words = len((resume_text or "").split())
    detail_score = 75 if resume_words >= 250 else 60 if resume_words >= 120 else 45
    soft_score = 65 if any(w in resume_lower for w in ["lead", "managed", "collaborated", "communication", "team"]) else 50
    industry_score = max(40, min(80, hard_score - 5))
    trajectory_score = 65 if any(w in resume_lower for w in ["project", "intern", "engineer", "developer", "manager", "analyst"]) else 50

    overall_hint = round(
        hard_score * 0.30
        + detail_score * 0.25
        + 55 * 0.10
        + soft_score * 0.15
        + industry_score * 0.12
        + trajectory_score * 0.08,
        1,
    )
    recommendation = (
        "strong_match" if overall_hint >= 80 else
        "good_match" if overall_hint >= 65 else
        "partial_match" if overall_hint >= 45 else
        "weak_match"
    )
    matched = matched[:4]
    gaps = gaps[:4]
    return {
        "hard_skills_match": {
            "score": hard_score,
            "reason": "Estimated from keyword overlap between resume and JD.",
            "matched": matched,
            "gaps": gaps,
        },
        "experience_fit": {
            "score": detail_score,
            "reason": "Estimated from amount of relevant resume detail.",
            "matched": matched[:2],
            "gaps": gaps[:2],
        },
        "education_alignment": {
            "score": 55,
            "reason": "Education fit could not be deeply evaluated without AI.",
            "matched": [],
            "gaps": [],
        },
        "soft_skills_signals": {
            "score": soft_score,
            "reason": "Estimated from teamwork and leadership wording.",
            "matched": [],
            "gaps": [],
        },
        "industry_relevance": {
            "score": industry_score,
            "reason": "Estimated from JD and resume term overlap.",
            "matched": matched[:3],
            "gaps": gaps[:3],
        },
        "career_trajectory": {
            "score": trajectory_score,
            "reason": "Estimated from role and project signals in the resume.",
            "matched": [],
            "gaps": [],
        },
        "overall_summary": "Estimated match score based on resume and job-description overlap.",
        "recommendation": recommendation,
        "why_this_person": "",
        "profile_signals": [],
        "outreach_draft": "",
    }


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
    messages = [{"role": "user", "content": f"Parse this job description:\n\n{truncate_jd(jd_text)}"}]
    try:
        result = await call_claude(system_prompt, messages, max_tokens=MAX_TOKENS["jd_parse"])
        parsed = safe_json_parse(result, fallback={})
        if not parsed:
            print(f"[parse_jd] Empty parse — raw: {result[:200]}")
        return parsed
    except Exception as e:
        print(f"[parse_jd] ERROR: {e}")
        return {}


async def score_candidate(
    resume_text: str,
    parsed_jd: dict,
    candidate_name: str,
    candidate_id: str = None,
    jd_id: str = None,
    force_refresh: bool = False,
) -> dict:
    # ── Normalise inputs — guard against None from DB null columns ───────
    resume_text = resume_text or ""
    parsed_jd   = parsed_jd   or {}

    resume_len = len(resume_text)
    print(
        f"[score_candidate] START candidate={candidate_name!r} id={candidate_id} "
        f"resume_len={resume_len} parsed_jd_keys={list(parsed_jd.keys())}"
    )

    # ── Short-circuit: no resume → use keyword-based fallback, skip Claude ─
    if resume_len < 50:
        print(f"[score_candidate] WARN: no/empty resume for {candidate_name!r} — using fallback scorer")
        return fallback_score_candidate(resume_text, json.dumps(parsed_jd), parsed_jd)

    # ── Cache check ───────────────────────────────────────────────────────
    if candidate_id and jd_id and not force_refresh:
        cached = get_cached_match_score(candidate_id, jd_id)
        if cached and cached.get("score_json"):
            score_json = cached["score_json"]
            # Accept cache only when: real score + no error text + insight fields present.
            # Entries that predate the insight fields (why_this_person missing/empty) are
            # treated as stale and re-scored so the new fields get generated.
            summary = score_json.get("overall_summary", "")
            has_insights = bool(score_json.get("why_this_person"))
            if (
                cached.get("total_score", 0) > 0
                and "Scoring unavailable" not in summary
                and "Unable to score" not in summary
                and has_insights
            ):
                print(f"[score_candidate] Cache HIT for candidate={candidate_id} jd={jd_id}")
                return score_json
            print(f"[score_candidate] Stale/poisoned cache for candidate={candidate_id} — re-scoring")

    system_prompt = (
        "You are a senior technical recruiter. Evaluate the candidate resume against the job requirements.\n\n"
        "Score across 6 dimensions. For each: score 0-100, reason ≤12 words with specific evidence, "
        "up to 3 matched items, up to 3 gaps. Keep all strings SHORT.\n\n"
        "Dimensions:\n"
        "1. hard_skills_match — technical skills vs required/nice-to-have. Semantic match allowed (React=ReactJS).\n"
        "2. experience_fit — years and seniority. Penalise under AND over-qualification.\n"
        "3. education_alignment — relevance of field, not just degree level.\n"
        "4. soft_skills_signals — infer from achievements, not listed keywords.\n"
        "5. industry_relevance — direct=high, adjacent=medium, unrelated=low.\n"
        "6. career_trajectory — consistent upward progression toward this role.\n\n"
        "Three extra fields (keep each BRIEF):\n"
        "why_this_person: 1-2 sentences max. Cite actual role or skill from resume.\n"
        "profile_signals: exactly 3 items. Mix strength/gap. Each signal ≤12 words, relevance ≤8 words.\n"
        "outreach_draft: 2-3 sentences. Start 'Hi [firstname],'. One resume fact. End with call-to-action.\n\n"
        "Return ONLY valid JSON — no markdown, no backticks, no text before or after the JSON object:\n"
        "{"
        '"hard_skills_match":{"score":0,"reason":"","matched":[],"gaps":[]},'
        '"experience_fit":{"score":0,"reason":"","matched":[],"gaps":[]},'
        '"education_alignment":{"score":0,"reason":"","matched":[],"gaps":[]},'
        '"soft_skills_signals":{"score":0,"reason":"","matched":[],"gaps":[]},'
        '"industry_relevance":{"score":0,"reason":"","matched":[],"gaps":[]},'
        '"career_trajectory":{"score":0,"reason":"","matched":[],"gaps":[]},'
        '"overall_summary":"short summary",'
        '"recommendation":"strong_match|good_match|partial_match|weak_match",'
        '"why_this_person":"brief pitch",'
        '"profile_signals":[{"signal":"","type":"strength|gap","relevance":""}],'
        '"outreach_draft":"Hi name, ..."'
        "}"
    )
    user_message = (
        f"Candidate name: {candidate_name}\n\n"
        f"Job requirements:\n{json.dumps(parsed_jd, indent=2)[:800]}\n\n"
        f"Candidate resume:\n{truncate_resume(resume_text)}"
    )
    messages = [{"role": "user", "content": user_message}]

    try:
        result = await call_claude(system_prompt, messages, max_tokens=1500)

        # ── Debug: log raw Claude output ──────────────────────────────────
        print(f"[score_candidate] Raw response (first 200 chars): {result[:200]}")

        # ── Robust JSON extraction (handles fences, leading text, etc.) ──
        parsed = _extract_json(result)

        if not parsed or "hard_skills_match" not in parsed:
            print(
                f"[score_candidate] WARN: missing required fields for {candidate_name!r}. "
                f"Keys found: {list(parsed.keys()) if parsed else 'none'}. "
                f"Full raw response: {result[:600]}"
            )
            return dict(_ERROR_SCORE_RESPONSE)

        print(f"[score_candidate] OK for {candidate_name!r} — recommendation={parsed.get('recommendation')}")
        return parsed

    except Exception:
        print(f"[score_candidate] EXCEPTION for candidate={candidate_id} name={candidate_name!r}:")
        traceback.print_exc()
        return dict(_ERROR_SCORE_RESPONSE)


def calculate_weighted_score(
    score_json: dict,
    weights: dict = None,
    parsed_jd: dict = None,
) -> float:
    """
    Calculates weighted total score out of 100.
    Priority: caller-supplied weights → dynamic JD weights → static defaults.
    """
    if weights is not None:
        w = weights
    elif parsed_jd:
        w = get_dynamic_weights(parsed_jd)
    else:
        w = _DEFAULT_WEIGHTS

    total = 0.0
    for dim in _DIMENSIONS:
        dim_data = score_json.get(dim, {})
        score = dim_data.get("score", 0) if isinstance(dim_data, dict) else (float(dim_data) if dim_data else 0)
        total += score * w.get(dim, 0)
    return round(total, 1)


async def rank_candidates(
    candidates: list, jd_text: str, parsed_jd: dict, weights: dict = None,
    jd_id: str = None, force_refresh: bool = False,
) -> list:
    tasks = [
        score_candidate(
            # Use `or ""` — .get("key", "") only fires when the key is absent,
            # NOT when the value is None (null in DB). `or ""` handles both.
            c.get("resume_text") or "",
            parsed_jd,
            c.get("name", "Unknown"),
            candidate_id=c.get("id"),
            jd_id=jd_id,
            force_refresh=force_refresh,
        )
        for c in candidates
    ]
    scores = await asyncio.gather(*tasks)

    results = []
    for candidate, score_json in zip(candidates, scores):
        total = calculate_weighted_score(score_json, weights, parsed_jd=parsed_jd)
        results.append({**candidate, "score_json": score_json, "total_score": total})

    results.sort(key=lambda x: x["total_score"], reverse=True)
    return results
