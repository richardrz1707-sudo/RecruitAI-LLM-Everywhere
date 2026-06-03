"""
Bias detection for recruiter shortlists.
Scans aggregated candidate data for patterns that may indicate bias.

CREDIT: one Haiku call per JD match run.
Cached by jd_id + shortlist composition hash.
"""
import hashlib

import anthropic

from app.config import settings
from app.database import supabase
from app.services.utils import safe_json_parse

client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)

BIAS_PROMPT = """Analyse this shortlist summary for potential bias patterns. Look for:
- Gender imbalance in top candidates
- Education institution concentration
- Experience pattern dominance
- Age/seniority clustering

Return ONLY JSON:
{
  "bias_detected": true or false,
  "patterns": ["pattern 1", "pattern 2"],
  "severity": "low|medium|high",
  "suggestion": "one actionable sentence",
  "diverse_signal": "one positive observation"
}

If shortlist looks diverse, return bias_detected: false with diverse_signal."""


def check_shortlist_bias(jd_id: str, candidates: list) -> dict:
    """
    Check shortlist for bias patterns.
    candidates: list of {name, score, score_json}
    Cached by jd_id + shortlist hash.
    """
    if len(candidates) < 3:
        return {"bias_detected": False}

    names_str = ",".join([c.get("name", "") for c in candidates[:10]])
    cache_key = hashlib.md5(f"{jd_id}{names_str}".encode()).hexdigest()[:16]

    try:
        cached = (
            supabase.table("jd_posts")
            .select("bias_check_json")
            .eq("id", jd_id)
            .single()
            .execute()
        )
        stored = cached.data.get("bias_check_json") if cached.data else None
        if stored and stored.get("cache_key") == cache_key:
            return stored
    except Exception:
        pass

    summary_lines = []
    for i, c in enumerate(candidates[:8], 1):
        score_json = c.get("score_json") or {}
        edu = score_json.get("education_alignment", {})
        exp = score_json.get("experience_fit", {})
        summary_lines.append(
            f"Candidate {i}: score={c.get('score', 0)}, "
            f"edu_reason='{str(edu.get('reason', ''))[:80]}', "
            f"exp_reason='{str(exp.get('reason', ''))[:80]}'"
        )

    try:
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=200,
            system=BIAS_PROMPT,
            messages=[{
                "role": "user",
                "content": (
                    f"Shortlist for this role ({len(candidates)} candidates):\n"
                    f"{chr(10).join(summary_lines)}"
                ),
            }],
            timeout=15.0,
        )

        raw = response.content[0].text if response.content else "{}"
        result = safe_json_parse(raw, fallback={"bias_detected": False})
        result["cache_key"] = cache_key

        try:
            supabase.table("jd_posts").update({"bias_check_json": result}).eq("id", jd_id).execute()
        except Exception:
            pass

        return result
    except Exception as e:
        print(f"Bias check error: {e}")
        return {"bias_detected": False}
