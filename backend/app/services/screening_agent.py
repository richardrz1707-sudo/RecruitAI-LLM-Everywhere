from app.services.llm import call_claude
from app.services.utils import (
    truncate_resume, truncate_jd, truncate_answer,
    get_cached_report, safe_json_parse,
    MAX_TOKENS,
)
from app.database import supabase

# Bump this when the question generation prompt changes significantly.
# Old cached questions (different version) will be regenerated automatically.
QUESTION_CACHE_VERSION = "v2"

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

Required tailoring rules (must follow):
- Q1: Reference something specific from the candidate resume - a role, project, or achievement. Make it personal to this candidate.
- Q2: Identify the most critical technical skill in the JD. Check if the resume shows evidence. If strong evidence: probe depth. If weak or missing: ask them to demonstrate it.
- Q3: Identify the most important soft skill the JD needs. Find evidence or absence in the resume. Ask a behavioural question.
- Q4: Identify ONE clear gap between JD requirements and resume. Ask about it honestly and directly.
- Q5: Connect their career trajectory from the resume to this specific role.

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
    candidate resume. Uses 900 tokens to avoid truncated JSON. Falls back
    to salvaging partial questions or FALLBACK_QUESTIONS.
    """
    import json as _json, re as _re

    user_message = (
        f"Job description:\n{jd_text[:1000]}\n\n"
        f"Candidate resume:\n{resume_text[:1500]}"
        if resume_text.strip()
        else
        f"Job description:\n{jd_text[:1000]}\n\n"
        f"No resume provided — generate role-specific "
        f"questions based on JD requirements only."
    )
    messages = [{"role": "user", "content": user_message}]

    # Prepend conciseness instruction so questions don't balloon token usage
    concise_prompt = (
        _QUESTION_SYSTEM_PROMPT +
        "\n\nIMPORTANT: Keep each question under 50 words. "
        "Be specific but concise. Do not write long preambles. "
        "Start the question directly."
    )

    try:
        result = await call_claude(
            concise_prompt, messages,
            max_tokens=900,  # raised from 500 — tailored questions are longer
            model="claude-haiku-4-5-20251001",
        )

        raw = result.strip() if result else ""
        clean = raw.replace("```json", "").replace("```", "").strip()

        # ── Attempt 1: parse complete JSON ──────────────────────────────
        start = clean.find("{")
        if start != -1:
            end = clean.rfind("}") + 1
            if end > start:
                try:
                    parsed = _json.loads(clean[start:end])
                    questions = parsed.get("questions", [])
                    if len(questions) >= 3:
                        # Accept ≥3 complete questions; fill rest with fallbacks
                        while len(questions) < 5:
                            questions.append(FALLBACK_QUESTIONS[len(questions)])
                        print(f"[questions] Parsed {len(questions)} questions OK")
                        return questions[:5]
                except _json.JSONDecodeError as je:
                    print(f"[questions] JSON parse error: {je}")

        # ── Attempt 2: salvage complete question objects from truncated JSON
        q_pattern = _re.compile(
            r'\{\s*"id"\s*:\s*(\d+)\s*,[^{}]*'
            r'"question"\s*:\s*"([^"]+)"\s*,[^{}]*'
            r'"dimension"\s*:\s*"([^"]+)"[^{}]*\}',
            _re.DOTALL
        )
        salvaged = []
        for match in q_pattern.finditer(clean):
            try:
                salvaged.append({
                    "id": int(match.group(1)),
                    "question": match.group(2),
                    "dimension": match.group(3),
                    "strong_answer_hint": "",
                    "probes_skill": "general"
                })
            except Exception:
                continue

        if len(salvaged) >= 3:
            print(f"[questions] Salvaged {len(salvaged)} questions from truncated response")
            while len(salvaged) < 5:
                salvaged.append(FALLBACK_QUESTIONS[len(salvaged)])
            return salvaged[:5]

        print("[questions] Could not parse response — using fallback questions")

    except Exception as e:
        print(f"[questions] Generation error: {e}")

    return FALLBACK_QUESTIONS


def log_question_tailoring(candidate_id: str | None, jd_id: str, resume_text: str, from_cache: bool, questions: list) -> None:
    print("Questions generated:")
    print(f"  candidate_id: {candidate_id}")
    print(f"  jd_id: {jd_id}")
    print(f"  has_resume: {bool(resume_text.strip())}")
    print(f"  from_cache: {from_cache}")
    print(f"  Q1 preview: {questions[0]['question'][:80]}")


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
    print(f"[questions] Checking cache jd_id={jd_id} candidate_id={candidate_id} version={QUESTION_CACHE_VERSION}")
    try:
        if candidate_id:
            cached = (
                supabase.table("interview_questions")
                .select("questions_json")
                .eq("candidate_id", candidate_id)
                .eq("jd_id", jd_id)
                .eq("prompt_version", QUESTION_CACHE_VERSION)
                .limit(1)
                .execute()
            )
        else:
            cached = (
                supabase.table("interview_questions")
                .select("questions_json")
                .eq("jd_id", jd_id)
                .is_("candidate_id", "null")
                .eq("prompt_version", QUESTION_CACHE_VERSION)
                .limit(1)
                .execute()
            )
        if cached.data:
            print("[questions] Cache HIT — no Claude call needed")
            questions = cached.data[0]["questions_json"]
            log_question_tailoring(candidate_id, jd_id, resume_text, True, questions)
            return questions, True
    except Exception as e:
        print(f"[questions] Cache lookup error: {e}")

    print("[questions] Cache MISS — generating with Claude")
    questions = await generate_questions(jd_text, resume_text)
    try:
        supabase.table("interview_questions").insert({
            "jd_id": jd_id,
            "candidate_id": candidate_id,
            "questions_json": questions,
            "prompt_version": QUESTION_CACHE_VERSION,
        }).execute()
    except Exception as e:
        print(f"[questions] Cache save error: {e}")
    log_question_tailoring(candidate_id, jd_id, resume_text, False, questions)
    return questions, False


INTERVIEW_TOOLS = [
    {
        "name": "ask_followup_question",
        "description": (
            "Ask a follow-up question when the candidate's answer needs more depth. "
            "Use when: answer is too vague, lacks a specific example, or misses a key "
            "JD requirement. Maximum 2 follow-ups per question, 6 total per session."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": (
                        "The specific follow-up question. Must reference either the "
                        "candidate's actual words OR a specific JD requirement. Never generic."
                    )
                },
                "followup_type": {
                    "type": "string",
                    "enum": ["probe_answer", "bridge_to_jd"],
                    "description": (
                        "probe_answer: candidate gave a vague answer that needs depth. "
                        "bridge_to_jd: answer missed a specific JD requirement."
                    )
                },
                "reasoning": {
                    "type": "string",
                    "description": "Why this follow-up is needed — what was missing from the answer."
                },
                "scores": {
                    "type": "object",
                    "description": (
                        "Dimension scores for this answer 0-100 each: "
                        "english_proficiency, answer_quality, soft_skills, job_fit"
                    )
                }
            },
            "required": ["question", "followup_type", "reasoning", "scores"]
        }
    },
    {
        "name": "advance_to_next_question",
        "description": (
            "Move to the next interview question when the current answer is satisfactory. "
            "Use when answer demonstrates the skill being probed with specific evidence."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "reasoning": {
                    "type": "string",
                    "description": "Why the answer was sufficient — what evidence was provided."
                },
                "scores": {
                    "type": "object",
                    "description": (
                        "Dimension scores 0-100 each: english_proficiency, "
                        "answer_quality, soft_skills, job_fit"
                    )
                }
            },
            "required": ["reasoning", "scores"]
        }
    },
    {
        "name": "generate_final_report",
        "description": (
            "End the interview and generate the final hiring report. "
            "Use when: all 5 questions are answered, OR turn limit is reached."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "reasoning": {"type": "string", "description": "Why the session is complete."},
                "scores": {"type": "object", "description": "Final answer dimension scores."}
            },
            "required": ["reasoning", "scores"]
        }
    },
    {
        "name": "flag_and_continue",
        "description": (
            "Flag an integrity concern and continue to the next question. "
            "Use when answer appears AI-generated or heavily scripted. "
            "Do NOT use for short or vague answers — use ask_followup_question instead."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "flag_type": {
                    "type": "string",
                    "enum": ["ai_generated", "scripted_response"]
                },
                "reasoning": {
                    "type": "string",
                    "description": "What signals indicate AI generation or scripting."
                },
                "scores": {"type": "object", "description": "Dimension scores."}
            },
            "required": ["flag_type", "reasoning", "scores"]
        }
    }
]


def get_interview_system_prompt(
    jd_title: str,
    required_skills: list,
    seniority: str
) -> str:
    skills_str = ", ".join(required_skills[:6]) if required_skills else "not specified"
    return f"""You are an expert technical interviewer evaluating a candidate for {jd_title}.

Role requirements:
- Required skills: {skills_str}
- Seniority: {seniority or 'not specified'}

After reading the candidate's answer, select exactly ONE tool:

TOOL SELECTION RULES:
- Answer is vague, generic, or lacks example → ask_followup_question (type: probe_answer)
- Answer misses a specific JD requirement → ask_followup_question (type: bridge_to_jd)
- Answer demonstrates the skill with evidence → advance_to_next_question
- All questions answered or turn limit reached → generate_final_report
- Answer reads like AI-generated text → flag_and_continue

SCORING RULES (0-100 per dimension):
english_proficiency: clarity, vocabulary, fluency
answer_quality: structure, specificity, evidence
soft_skills: leadership, teamwork, self-awareness
job_fit: relevance to role requirements

FOLLOW-UP QUESTION RULES:
- probe_answer: reference the candidate's exact words and ask for more depth
  e.g. "You mentioned [X] — can you walk me through [specific aspect]?"
- bridge_to_jd: reference the JD requirement that was missed
  e.g. "This role requires [requirement] — can you speak to your experience with that?"

FOLLOW-UP QUESTION TEMPLATES:

For probe_answer — use this structure:
"You mentioned [exact phrase from answer] — can you [specific deeper question about it]?"

Example: "You mentioned leading a team — how large was the team and what was your specific decision-making authority?"

For bridge_to_jd — use this structure:
"This role requires [specific JD requirement] — can you [speak to / walk me through / describe] your experience with that specifically?"

Example: "This role requires Python for ML pipelines — your answer focused on R. Can you describe any Python projects you have worked on?"

Always quote either the candidate's words OR a specific JD requirement. Never ask "Can you tell me more?" or "Can you elaborate?"""


def evaluate_answer_with_tools(
    question: dict,
    answer: str,
    jd_text: str = "",
    parsed_jd: dict = None,
    resume_text: str = "",
    is_followup: bool = False,
    followups_used: int = 0,
    followups_this_question: int = 0,
    question_number: int = 1,
    total_turns: int = 0
) -> dict:
    """
    Evaluates a candidate's answer using Anthropic native tool use.
    Claude selects the tool — Python executes it.

    This satisfies Pillar 1: LLM decides routing, not Python if/else logic.
    """
    from app.config import settings
    import anthropic as ant

    ant_client = ant.Anthropic(api_key=settings.ANTHROPIC_API_KEY)

    _default_scores = {
        "english_proficiency": 50,
        "answer_quality": 50,
        "soft_skills": 50,
        "job_fit": 50
    }

    # Force complete if session limits reached
    force_complete = (
        followups_used >= 6 or
        total_turns >= 17 or
        (question_number >= 5 and not is_followup)
    )
    if force_complete and question_number >= 5:
        return {
            "tool_selected": "generate_final_report",
            "tool_input": {"reasoning": "Session limits reached", "scores": _default_scores},
            "scores": _default_scores,
            "reasoning": "Session limits reached",
            "followup_type": None,
            "followup_question": None,
            "ai_flag": False,
            "ai_confidence": "none"
        }

    parsed = parsed_jd or {}
    system_prompt = get_interview_system_prompt(
        jd_title=parsed.get("role_title", "this role"),
        required_skills=parsed.get("required_skills", []),
        seniority=parsed.get("seniority_level", "")
    )

    followup_limit_note = ""
    if followups_this_question >= 2:
        followup_limit_note = (
            "\nNOTE: This question has used its maximum follow-ups. "
            "You MUST select advance_to_next_question or generate_final_report."
        )
    elif followups_used >= 5:
        followup_limit_note = (
            "\nNOTE: Only 1 follow-up remaining for the entire session. Use it wisely."
        )

    # Build structured JD requirements context for anchored follow-ups
    jd_requirements = ""
    if parsed:
        required = parsed.get("required_skills", [])[:6]
        nice = parsed.get("nice_to_have", [])[:3]
        min_exp = parsed.get("min_years_experience", "")
        key_resp = parsed.get("key_responsibilities", [])[:3]

        jd_requirements = (
            f"\nJD requirements for follow-up context:\n"
            f"Required skills: {', '.join(required)}\n"
        ) if required else ""
        if nice:
            jd_requirements += f"Nice to have: {', '.join(nice)}\n"
        if min_exp:
            jd_requirements += f"Min experience: {min_exp}\n"
        if key_resp:
            jd_requirements += f"Key responsibilities: {'; '.join(key_resp)}\n"

    # Resume highlights so Claude can anchor bridge_to_jd follow-ups
    resume_context = ""
    if resume_text and len(resume_text.strip()) > 50:
        resume_context = (
            f"\nCandidate resume highlights (first 600 chars):\n"
            f"{resume_text[:600]}"
        )

    user_message = (
        f"Question being evaluated:\n{question['question']}\n\n"
        f"Skill being probed: {question.get('probes_skill', 'general')}\n"
        f"Expected in strong answer: {question.get('strong_answer_hint', '')}\n"
        f"{jd_requirements}"
        f"{resume_context}\n\n"
        f"Candidate answer:\n{answer[:500]}\n\n"
        f"Context:\n"
        f"- Question {question_number} of 5\n"
        f"- Is this a follow-up: {is_followup}\n"
        f"- Follow-ups used this question: {followups_this_question}/2\n"
        f"- Total follow-ups used: {followups_used}/6\n"
        f"- Total turns: {total_turns}/17"
        f"{followup_limit_note}"
    )

    # Remove ask_followup_question when limits are reached
    available_tools = INTERVIEW_TOOLS
    if followups_this_question >= 2 or followups_used >= 6:
        available_tools = [
            t for t in INTERVIEW_TOOLS if t["name"] != "ask_followup_question"
        ]

    try:
        response = ant_client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=400,
            system=system_prompt,
            tools=available_tools,
            tool_choice={"type": "any"},
            messages=[{"role": "user", "content": user_message}],
            timeout=20.0
        )

        tool_block = next(
            (b for b in response.content if hasattr(b, "type") and b.type == "tool_use"),
            None
        )

        if not tool_block:
            return _fallback_evaluation(answer)

        tool_name = tool_block.name
        tool_input = tool_block.input
        scores = tool_input.get("scores", _default_scores)

        print(f"[Interview Agent] Tool selected: {tool_name}")
        print(f"[Interview Agent] Reasoning: {tool_input.get('reasoning', '')[:100]}")

        return {
            "tool_selected": tool_name,
            "tool_input": tool_input,
            "scores": scores,
            "reasoning": tool_input.get("reasoning", ""),
            "followup_type": tool_input.get("followup_type"),
            "followup_question": (
                tool_input.get("question")
                if tool_name == "ask_followup_question" else None
            ),
            "ai_flag": tool_name == "flag_and_continue",
            "ai_confidence": "high" if tool_name == "flag_and_continue" else "none"
        }

    except Exception as e:
        import traceback
        print(f"[Interview Agent] Error: {e}")
        print(traceback.format_exc())
        return _fallback_evaluation(answer)


def _fallback_evaluation(answer: str) -> dict:
    """Fallback when tool use fails. Advances the interview safely."""
    word_count = len(answer.split())
    needs_fup = word_count < 30
    return {
        "tool_selected": "ask_followup_question" if needs_fup else "advance_to_next_question",
        "tool_input": {
            "reasoning": "Fallback evaluation",
            "scores": {"english_proficiency": 50, "answer_quality": 50, "soft_skills": 50, "job_fit": 50}
        },
        "scores": {"english_proficiency": 50, "answer_quality": 50, "soft_skills": 50, "job_fit": 50},
        "reasoning": "Fallback evaluation",
        "followup_type": None,
        "followup_question": "Could you give a more specific example?" if needs_fup else None,
        "ai_flag": False,
        "ai_confidence": "none"
    }


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
