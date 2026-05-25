import json
import re
from app.services.llm import call_claude
from app.database import supabase

# Cost-saving truncation limits
JD_MAX_CHARS = 1000      # truncate JD before any prompt
RESUME_MAX_CHARS = 1500  # truncate resume before any prompt

FALLBACK_QUESTIONS = [
    {"id": 1, "question": "Please introduce yourself and summarise your relevant experience.", "dimension": "english_proficiency", "strong_answer_hint": "Clear structured intro with role-relevant highlights"},
    {"id": 2, "question": "What specific skills and experience make you a strong fit for this role?", "dimension": "job_fit", "strong_answer_hint": "Concrete skills matched to role requirements with examples"},
    {"id": 3, "question": "Describe a challenging situation at work and how you resolved it.", "dimension": "answer_quality", "strong_answer_hint": "STAR method — clear situation, specific actions, measurable result"},
    {"id": 4, "question": "How would you approach the first 30 days in this role?", "dimension": "soft_skills", "strong_answer_hint": "Shows initiative, planning, stakeholder awareness"},
    {"id": 5, "question": "Why are you interested in this specific role and company?", "dimension": "job_fit", "strong_answer_hint": "Genuine motivation, research shown, aligned goals"},
]

_QUESTION_SYSTEM_PROMPT = """Generate exactly 5 interview screening questions for this job role.

Rules:
- Q1: easy opener — background and experience summary
- Q2: role-specific technical or skill question based on JD
- Q3: behavioural question — a past challenge or achievement
- Q4: situational question — how they would handle a scenario relevant to the role
- Q5: motivation question — why this role, career goals

Each question must also have:
- dimension: one of english_proficiency | answer_quality | soft_skills | job_fit
- strong_answer_hint: what a good answer looks like (used for scoring only, not shown to candidate)

Return ONLY valid JSON, no markdown, no backticks:
{
  "questions": [
    {"id": 1, "question": "string", "dimension": "string", "strong_answer_hint": "string"}
  ]
}"""

_EVAL_SYSTEM_PROMPT = """Evaluate a candidate's screening answer for a job interview.
Return ONLY valid JSON, no markdown, no backticks.

Score 4 dimensions (0-100 each):
- english_proficiency: clarity, grammar, vocabulary, fluency
- answer_quality: structure, specificity, use of examples, depth
- soft_skills: self-awareness, teamwork signals, communication, professionalism
- job_fit: relevance to role, domain knowledge, enthusiasm shown

Also decide on follow-up:
- needs_followup: true only if answer is vague or lacks any concrete example AND this is not already a follow-up
- follow_up_question: one short probing question if needs_followup true, else null

AI detection:
- ai_generated_flag: true if the answer reads like AI-generated text
- Signs of AI: overly formal structure, perfect grammar with no personality, generic examples not specific to the candidate, unnaturally comprehensive coverage, phrases like "Furthermore", "It is worth noting", "In conclusion", "This demonstrates my ability to"
- ai_confidence: high = very likely AI, medium = suspicious, low = possibly AI, none = reads like natural human writing
- Natural human writing has: informal phrasing, specific personal anecdotes, occasional grammar imperfections, direct first-person voice, focused on one or two points

Return:
{
  "scores": {"english_proficiency": 0-100, "answer_quality": 0-100, "soft_skills": 0-100, "job_fit": 0-100},
  "needs_followup": true|false,
  "follow_up_question": "string or null",
  "ai_generated_flag": true|false,
  "ai_confidence": "high|medium|low|none"
}"""

_REPORT_SYSTEM_PROMPT = """Generate a recruiter-facing candidate screening report based on interview scores.
Return ONLY valid JSON, no markdown, no backticks.

{
  "overall_score": number,
  "overall_grade": "A|B|C|D|F",
  "hire_recommendation": "strong_yes|yes|maybe|no",
  "headline": "one sentence recruiter summary of this candidate",
  "strengths": ["strength1", "strength2"],
  "concerns": ["concern1", "concern2"],
  "suggested_interview_topics": ["topic1", "topic2"],
  "dimension_summary": {
    "english_proficiency": "one sentence",
    "answer_quality": "one sentence",
    "soft_skills": "one sentence",
    "job_fit": "one sentence"
  },
  "speech_analysis": "one sentence summary of speaking pace and fluency if speech metrics are provided, else null"
}

hire_recommendation guide: strong_yes>=80, yes>=65, maybe>=50, no<50"""


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
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if m:
            try:
                return json.loads(m.group())
            except json.JSONDecodeError:
                pass
    return {}


async def generate_questions(jd_text: str) -> list:
    # Cost-saving: truncate JD to 1000 chars before sending to Claude
    jd_trimmed = jd_text[:JD_MAX_CHARS]
    messages = [{"role": "user", "content": f"Job description: {jd_trimmed}"}]
    try:
        result = await call_claude(
            _QUESTION_SYSTEM_PROMPT, messages,
            max_tokens=500, model="claude-haiku-4-5-20251001",
        )
        parsed = _extract_json(result)
        questions = parsed.get("questions", [])
        if len(questions) == 5:
            return questions
    except Exception:
        pass
    return FALLBACK_QUESTIONS


async def get_or_create_questions(jd_id: str, jd_text: str) -> tuple:
    # Cache key is jd_id only — all candidates on same JD share the same questions
    print(f"[questions] Checking cache for jd_id={jd_id}")
    cached = (
        supabase.table("interview_questions")
        .select("questions_json")
        .eq("jd_id", jd_id)
        .execute()
    )
    if cached.data:
        print("[questions] Cache HIT — no Claude call needed")
        return cached.data[0]["questions_json"], True

    print("[questions] Cache MISS — generating questions with Claude")
    questions = await generate_questions(jd_text)
    supabase.table("interview_questions").insert(
        {"jd_id": jd_id, "questions_json": questions}
    ).execute()
    return questions, False


async def evaluate_answer(question: dict, answer: str, is_followup: bool) -> dict:
    # Cost-saving: send only current question + answer, not full history
    user_message = (
        f"Question: {question['question']}\n"
        f"Hint: {question.get('strong_answer_hint', '')}\n"
        f"Answer: {answer}\n"
        f"Already a follow-up: {is_followup}"
    )
    messages = [{"role": "user", "content": user_message}]
    try:
        result = await call_claude(
            _EVAL_SYSTEM_PROMPT, messages,
            max_tokens=350, model="claude-haiku-4-5-20251001",
        )
        parsed = _extract_json(result)
        if parsed and "scores" in parsed:
            return parsed
    except Exception:
        pass
    return {
        "scores": {"english_proficiency": 70, "answer_quality": 70, "soft_skills": 70, "job_fit": 70},
        "needs_followup": False,
        "follow_up_question": None,
        "ai_generated_flag": False,
        "ai_confidence": "none",
    }


async def generate_report(scores_list: list, jd_title: str, aggregate_speech: dict | None = None) -> dict:
    dims = ["english_proficiency", "answer_quality", "soft_skills", "job_fit"]
    # Cost-saving: compute averages first, send only numbers to Claude
    avg = {
        d: round(sum(s["scores"][d] for s in scores_list) / len(scores_list))
        for d in dims
    }
    overall = round(sum(avg.values()) / 4)
    grade = (
        "A" if overall >= 85 else
        "B" if overall >= 70 else
        "C" if overall >= 55 else
        "D" if overall >= 40 else "F"
    )
    hire_rec = (
        "strong_yes" if overall >= 80 else
        "yes" if overall >= 65 else
        "maybe" if overall >= 50 else "no"
    )

    user_message = (
        f"Role: {jd_title}\n"
        f"Scores: english_proficiency={avg['english_proficiency']}, "
        f"answer_quality={avg['answer_quality']}, "
        f"soft_skills={avg['soft_skills']}, job_fit={avg['job_fit']}\n"
        f"Overall: {overall}/100\n"
        f"Questions answered: {len(scores_list)}"
    )
    if aggregate_speech:
        user_message += (
            f"\nSpeech metrics (aggregated across {aggregate_speech.get('questions_with_speech', 0)} questions): "
            f"avg WPM={aggregate_speech.get('avg_wpm', 'N/A')}, "
            f"total filler words={aggregate_speech.get('total_filler_words', 0)}, "
            f"total speech duration={aggregate_speech.get('total_duration_seconds', 0):.0f}s"
        )
    messages = [{"role": "user", "content": user_message}]
    try:
        result = await call_claude(
            _REPORT_SYSTEM_PROMPT, messages,
            max_tokens=600, model="claude-haiku-4-5-20251001",
        )
        parsed = _extract_json(result)
        if parsed and "overall_score" in parsed:
            return parsed
    except Exception:
        pass

    return {
        "overall_score": overall,
        "overall_grade": grade,
        "hire_recommendation": hire_rec,
        "headline": f"Candidate completed screening for {jd_title} with an overall score of {overall}/100.",
        "strengths": ["Completed the full screening process"],
        "concerns": ["Unable to generate detailed analysis"],
        "suggested_interview_topics": ["Role-specific experience", "Technical skills"],
        "dimension_summary": {
            "english_proficiency": f"Score: {avg['english_proficiency']}/100",
            "answer_quality": f"Score: {avg['answer_quality']}/100",
            "soft_skills": f"Score: {avg['soft_skills']}/100",
            "job_fit": f"Score: {avg['job_fit']}/100",
        },
        "speech_analysis": None,
    }
