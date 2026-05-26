from app.services.llm import call_claude
from app.services.utils import (
    truncate_resume, truncate_jd, truncate_answer,
    get_cached_report, safe_json_parse,
    MAX_TOKENS,
)
from app.database import supabase

FALLBACK_QUESTIONS = [
    {
        "id": 1,
        "question": "Tell me about your most relevant experience for this role.",
        "dimension": "english_proficiency",
        "strong_answer_hint": "Specific structured intro referencing relevant experience",
        "probes_skill": "communication",
    },
    {
        "id": 2,
        "question": "Walk me through a technical challenge you solved in a previous role.",
        "dimension": "answer_quality",
        "strong_answer_hint": "STAR method with measurable outcome",
        "probes_skill": "technical depth",
    },
    {
        "id": 3,
        "question": "Describe a time you had to work through a conflict with a teammate.",
        "dimension": "soft_skills",
        "strong_answer_hint": "Shows empathy, resolution, self-awareness",
        "probes_skill": "collaboration",
    },
    {
        "id": 4,
        "question": "What aspect of this role will require the most growth from you?",
        "dimension": "soft_skills",
        "strong_answer_hint": "Honest self-assessment with a growth plan",
        "probes_skill": "self-awareness",
    },
    {
        "id": 5,
        "question": "Why this role and why now in your career?",
        "dimension": "job_fit",
        "strong_answer_hint": "Genuine motivation aligned with career direction",
        "probes_skill": "motivation",
    },
]

_QUESTION_SYSTEM_PROMPT = """Generate exactly 5 spoken interview questions tailored to both the job description and the candidate's resume.
These are SPEECH interviews — questions must be natural to answer verbally, not in writing.

Question structure (follow this order):
- Q1: opener — reference a specific role or project from the candidate resume. Make it personal.
- Q2: hard skill deep-dive — identify the most critical technical skill in the JD. Check the resume for evidence of it. If strong evidence exists, probe depth. If weak or missing, ask them to demonstrate or explain it.
- Q3: soft skill probe — identify the most important soft skill the JD needs. Find evidence or absence in the resume and probe it directly with a behavioural question.
- Q4: gap question — identify one clear gap between JD requirements and resume. Ask about it honestly and directly.
- Q5: motivation and trajectory — connect their career story from the resume to this specific role.

For each question provide:
- dimension: english_proficiency | answer_quality | soft_skills | job_fit
- strong_answer_hint: what a strong spoken answer includes (for scoring, not shown to candidate)
- probes_skill: the exact skill or trait being assessed (shown to recruiter in answer review)

Return ONLY valid JSON, no markdown, no backticks:
{
  "questions": [
    {
      "id": 1,
      "question": "string",
      "dimension": "string",
      "strong_answer_hint": "string",
      "probes_skill": "string"
    }
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


async def generate_questions(jd_text: str, resume_text: str = "") -> list:
    """
    Generate 5 speech interview questions tailored to both the JD and the
    candidate resume. JD truncated to JD_MAX_CHARS, resume to RESUME_MAX_CHARS.
    """
    resume_section = (
        f"\nCandidate resume (truncated):\n{truncate_resume(resume_text)}"
        if resume_text.strip()
        else "\nNo resume provided — base questions on JD only."
    )
    user_message = (
        f"Job description (truncated):\n{truncate_jd(jd_text)}"
        f"{resume_section}"
    )
    messages = [{"role": "user", "content": user_message}]
    try:
        result = await call_claude(
            _QUESTION_SYSTEM_PROMPT, messages,
            max_tokens=MAX_TOKENS["question_gen"], model="claude-haiku-4-5-20251001",
        )
        parsed = safe_json_parse(result, fallback={})
        questions = parsed.get("questions", [])
        if len(questions) == 5 and all("probes_skill" in q for q in questions):
            return questions
    except Exception as e:
        print(f"[questions] Generation error: {e}")
    return FALLBACK_QUESTIONS


async def get_or_create_questions(
    jd_id: str,
    jd_text: str,
    candidate_id: str | None = None,
    resume_text: str = "",
) -> tuple:
    """
    Cache key is (candidate_id, jd_id) for resume-personalised questions.
    candidate_id=None means generic questions for the JD (no resume provided).
    """
    print(f"[questions] Checking cache jd_id={jd_id} candidate_id={candidate_id}")
    try:
        if candidate_id:
            cached = (
                supabase.table("interview_questions")
                .select("questions_json")
                .eq("candidate_id", candidate_id)
                .eq("jd_id", jd_id)
                .limit(1)
                .execute()
            )
        else:
            cached = (
                supabase.table("interview_questions")
                .select("questions_json")
                .eq("jd_id", jd_id)
                .is_("candidate_id", "null")
                .limit(1)
                .execute()
            )
        if cached.data:
            print("[questions] Cache HIT — no Claude call needed")
            return cached.data[0]["questions_json"], True
    except Exception as e:
        print(f"[questions] Cache lookup error: {e}")

    print("[questions] Cache MISS — generating with Claude")
    questions = await generate_questions(jd_text, resume_text)
    try:
        supabase.table("interview_questions").insert({
            "jd_id": jd_id,
            "candidate_id": candidate_id,
            "questions_json": questions,
        }).execute()
    except Exception as e:
        print(f"[questions] Cache save error: {e}")
    return questions, False


async def evaluate_answer(question: dict, answer: str, is_followup: bool) -> dict:
    user_message = (
        f"Question: {question['question']}\n"
        f"Probes skill: {question.get('probes_skill', 'general')}\n"
        f"Hint: {question.get('strong_answer_hint', '')}\n"
        f"Answer: {truncate_answer(answer)}\n"
        f"Already a follow-up: {is_followup}"
    )
    messages = [{"role": "user", "content": user_message}]
    try:
        result = await call_claude(
            _EVAL_SYSTEM_PROMPT, messages,
            max_tokens=MAX_TOKENS["answer_eval"], model="claude-haiku-4-5-20251001",
        )
        parsed = safe_json_parse(result, fallback={})
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


async def generate_report(
    scores_list: list,
    jd_title: str,
    aggregate_speech: dict | None = None,
) -> dict:
    dims = ["english_proficiency", "answer_quality", "soft_skills", "job_fit"]
    # Compute averages first — send only numbers to Claude (not raw transcripts)
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
            max_tokens=MAX_TOKENS["report_gen"], model="claude-haiku-4-5-20251001",
        )
        parsed = safe_json_parse(result, fallback={})
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
