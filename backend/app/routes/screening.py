"""
Phase 4 – AI Screening Agent routes
(anti-cheat Tier 1+2, interview modes, answer transcript, recruiter decisions)
"""
import secrets
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Depends
from app.models.schemas import (
    CreateScreeningLinkRequest,
    RegisterCandidateRequest,
    ScreeningAnswerRequest,
    SessionDecisionRequest,
)
from app.database import supabase, get_authed_client
from app.services.screening_agent import (
    get_or_create_questions,
    evaluate_answer,
    generate_report,
)

router = APIRouter(prefix="/screening", tags=["screening"])

FRONTEND_URL = "http://localhost:5173"


# ── Integrity helpers ─────────────────────────────────────────────────────

def compute_integrity_flags(signals, ai_flag, ai_confidence, answer, response_time_ms):
    flags = []

    if signals:
        word_count = signals.get("answer_word_count", 0) or 0
        time_ms = signals.get("total_response_time_ms", 0) or 0

        if signals.get("was_pasted"):
            flags.append({
                "type": "paste_detected",
                "detail": f"Answer was pasted ({signals.get('paste_count', 1)} paste event(s))",
            })

        if time_ms and word_count and word_count > 30:
            ms_per_word = time_ms / max(word_count, 1)
            if ms_per_word < 500:
                flags.append({
                    "type": "unusually_fast",
                    "detail": f"{word_count} words submitted in {round(time_ms / 1000, 1)}s",
                })

        tab_switches = signals.get("tab_switch_count", 0) or 0
        time_away = signals.get("total_time_away_ms", 0) or 0
        if tab_switches >= 2:
            flags.append({
                "type": "tab_switching",
                "detail": f"Switched tabs {tab_switches} times (total {round(time_away / 1000, 0)}s away)",
            })
        elif tab_switches == 1 and time_away > 15000:
            flags.append({
                "type": "tab_switching",
                "detail": f"Left page for {round(time_away / 1000, 0)}s during this answer",
            })

    if ai_flag and ai_confidence in ("high", "medium"):
        flags.append({
            "type": "ai_generated",
            "detail": f"Answer may be AI-generated (confidence: {ai_confidence})",
        })

    flag_types = [f["type"] for f in flags]
    if "ai_generated" in flag_types and ai_confidence == "high":
        risk_level = "suspicious"
    elif len(flags) >= 2:
        risk_level = "suspicious"
    elif len(flags) == 1:
        risk_level = "review"
    else:
        risk_level = "clean"

    return {"risk_level": risk_level, "flags": flags, "raw_signals": signals or {}}


def compute_overall_integrity(scores_json):
    suspicious_count = sum(1 for s in scores_json if s.get("integrity_risk") == "suspicious")
    review_count = sum(1 for s in scores_json if s.get("integrity_risk") == "review")
    ai_flags = [s for s in scores_json if s.get("ai_generated_flag")]

    if suspicious_count >= 2 or (suspicious_count >= 1 and review_count >= 1):
        overall_risk = "high"
        verdict = "Multiple integrity concerns detected. Manual review strongly recommended."
    elif suspicious_count == 1 or review_count >= 2:
        overall_risk = "medium"
        verdict = "Some integrity concerns detected. Consider probing flagged answers in live interview."
    elif review_count == 1:
        overall_risk = "low"
        verdict = "Minor concern detected. Review flagged answer before proceeding."
    else:
        overall_risk = "none"
        verdict = "No integrity concerns detected."

    per_question = [
        {
            "question_index": s.get("question_index", i),
            "integrity_risk": s.get("integrity_risk", "clean"),
            "flags": s.get("integrity_flags", []),
        }
        for i, s in enumerate(scores_json)
    ]

    return {
        "overall_risk": overall_risk,
        "verdict": verdict,
        "suspicious_answers": suspicious_count,
        "review_answers": review_count,
        "ai_flagged_count": len(ai_flags),
        "per_question": per_question,
    }


def compute_aggregate_speech(scores_json):
    entries = [s for s in scores_json if s.get("speech_metrics")]
    if not entries:
        return None

    total_duration = sum((s["speech_metrics"].get("duration_seconds") or 0) for s in entries)
    total_filler = sum((s["speech_metrics"].get("filler_word_count") or 0) for s in entries)
    wpm_list = [
        s["speech_metrics"]["words_per_minute"]
        for s in entries
        if s["speech_metrics"].get("words_per_minute")
    ]
    avg_wpm = round(sum(wpm_list) / len(wpm_list), 1) if wpm_list else None

    return {
        "questions_with_speech": len(entries),
        "total_duration_seconds": round(total_duration, 1),
        "total_filler_words": total_filler,
        "avg_wpm": avg_wpm,
    }


# ── 1. Create or fetch a screening link (recruiter — auth required) ──────
@router.post("/create-link")
async def create_screening_link(
    req: CreateScreeningLinkRequest,
    client=Depends(get_authed_client),
):
    existing = (
        client.table("screening_links")
        .select("token, interview_mode")
        .eq("jd_id", req.jd_id)
        .execute()
    )
    if existing.data:
        token = existing.data[0]["token"]
        current_mode = existing.data[0].get("interview_mode", "text_only")
        if current_mode != req.interview_mode:
            client.table("screening_links").update(
                {"interview_mode": req.interview_mode}
            ).eq("jd_id", req.jd_id).execute()
        return {
            "token": token,
            "url": f"{FRONTEND_URL}/screen/{token}",
            "interview_mode": req.interview_mode,
        }

    token = secrets.token_urlsafe(12)
    client.table("screening_links").insert(
        {"jd_id": req.jd_id, "token": token, "interview_mode": req.interview_mode}
    ).execute()
    return {
        "token": token,
        "url": f"{FRONTEND_URL}/screen/{token}",
        "interview_mode": req.interview_mode,
    }


# ── 2. Get existing link info for a JD (recruiter — auth required) ───────
@router.get("/link/{jd_id}")
async def get_screening_link(jd_id: str, client=Depends(get_authed_client)):
    result = (
        client.table("screening_links")
        .select("token, created_at, interview_mode")
        .eq("jd_id", jd_id)
        .execute()
    )
    if not result.data:
        return {"link": None}
    row = result.data[0]
    return {
        "token": row["token"],
        "url": f"{FRONTEND_URL}/screen/{row['token']}",
        "created_at": row["created_at"],
        "interview_mode": row.get("interview_mode", "text_only"),
    }


# ── 3. Public: verify token ───────────────────────────────────────────────
@router.get("/start/{token}")
async def start_screening(token: str):
    link = (
        supabase.table("screening_links")
        .select("jd_id, interview_mode")
        .eq("token", token)
        .execute()
    )
    if not link.data:
        raise HTTPException(status_code=404, detail="Invalid or expired screening link")

    jd_id = link.data[0]["jd_id"]
    interview_mode = link.data[0].get("interview_mode", "text_only")

    jd = supabase.table("jd_posts").select("title").eq("id", jd_id).execute()
    if not jd.data:
        raise HTTPException(status_code=404, detail="Job description not found")

    return {
        "jd_id": jd_id,
        "jd_title": jd.data[0]["title"],
        "is_valid": True,
        "interview_mode": interview_mode,
    }


# ── 4. Public: register candidate ────────────────────────────────────────
@router.post("/register")
async def register_candidate(req: RegisterCandidateRequest):
    link = (
        supabase.table("screening_links")
        .select("id, jd_id, interview_mode")
        .eq("token", req.token)
        .execute()
    )
    if not link.data:
        raise HTTPException(status_code=404, detail="Invalid screening link")

    link_id = link.data[0]["id"]
    jd_id = link.data[0]["jd_id"]
    interview_mode = link.data[0].get("interview_mode", "text_only")

    jd = supabase.table("jd_posts").select("jd_text").eq("id", jd_id).execute()
    if not jd.data:
        raise HTTPException(status_code=404, detail="Job description not found")

    questions, _ = await get_or_create_questions(jd_id, jd.data[0]["jd_text"])

    session_result = (
        supabase.table("screening_sessions")
        .insert({
            "link_id": link_id,
            "jd_id": jd_id,
            "candidate_name": req.candidate_name,
            "candidate_email": req.candidate_email,
            "resume_text": (req.resume_text or "")[:1500],
            "status": "in_progress",
            "current_question_index": 0,
            "scores_json": [],
            "transcript_json": [],
            "interview_mode": interview_mode,
            "integrity_agreement": {
                "agreed": req.integrity_agreed,
                "version": req.agreement_version,
                "agreed_at": req.agreed_at,
            },
        })
        .execute()
    )
    session_id = session_result.data[0]["id"]
    first_q = questions[0]
    return {
        "session_id": session_id,
        "question": {"id": first_q["id"], "question": first_q["question"]},
        "current_index": 0,
        "total_questions": len(questions),
    }


# ── 5. Public: submit an answer ───────────────────────────────────────────
@router.post("/answer")
async def submit_answer(req: ScreeningAnswerRequest):
    word_count = len(req.answer.strip().split())
    if word_count < 10:
        raise HTTPException(
            status_code=400,
            detail="Answer is too short. Please write at least 10 words.",
        )

    session_result = (
        supabase.table("screening_sessions")
        .select("*")
        .eq("id", req.session_id)
        .execute()
    )
    if not session_result.data:
        raise HTTPException(status_code=404, detail="Session not found")

    session = session_result.data[0]
    if session["status"] == "completed":
        raise HTTPException(status_code=400, detail="Session already completed")

    current_idx = session["current_question_index"]
    scores_so_far = session["scores_json"] or []
    transcript_so_far = session.get("transcript_json") or []
    jd_id = session["jd_id"]

    questions_result = (
        supabase.table("interview_questions")
        .select("questions_json")
        .eq("jd_id", jd_id)
        .execute()
    )
    if not questions_result.data:
        raise HTTPException(status_code=500, detail="Questions not found for session")

    questions = questions_result.data[0]["questions_json"]
    current_question = questions[current_idx]

    evaluation = await evaluate_answer(current_question, req.answer, req.is_followup)

    # Follow-up needed — store original answer in transcript, return early
    if evaluation.get("needs_followup") and not req.is_followup:
        fup_q = evaluation.get("follow_up_question", "")
        transcript_entry = {
            "question_index": current_idx,
            "question": current_question["question"],
            "dimension": current_question.get("dimension", ""),
            "answer": req.answer,
            "is_followup": False,
            "follow_up_question": fup_q,
        }
        supabase.table("screening_sessions").update({
            "transcript_json": transcript_so_far + [transcript_entry],
        }).eq("id", req.session_id).execute()

        return {
            "needs_followup": True,
            "follow_up_question": fup_q,
            "next_question": None,
            "current_index": current_idx,
            "total_questions": len(questions),
            "is_complete": False,
        }

    # Integrity signals
    signals_dict = None
    if req.integrity_signals:
        try:
            signals_dict = req.integrity_signals.model_dump()
        except AttributeError:
            signals_dict = req.integrity_signals.dict()

    integrity_summary = compute_integrity_flags(
        signals=signals_dict,
        ai_flag=evaluation.get("ai_generated_flag", False),
        ai_confidence=evaluation.get("ai_confidence", "none"),
        answer=req.answer,
        response_time_ms=signals_dict.get("total_response_time_ms") if signals_dict else None,
    )

    # Speech metrics
    speech_metrics_dict = None
    if req.speech_metrics:
        try:
            speech_metrics_dict = req.speech_metrics.model_dump()
        except AttributeError:
            speech_metrics_dict = req.speech_metrics.dict()

    # Build transcript entry for this answer
    if req.is_followup:
        # Retrieve the follow-up question text stored when it was triggered
        fup_q_text = "Follow-up question"
        for entry in reversed(transcript_so_far):
            if (
                entry.get("question_index") == current_idx
                and not entry.get("is_followup")
                and entry.get("follow_up_question")
            ):
                fup_q_text = entry["follow_up_question"]
                break
        transcript_entry = {
            "question_index": current_idx,
            "question": fup_q_text,
            "dimension": current_question.get("dimension", ""),
            "answer": req.answer,
            "is_followup": True,
        }
    else:
        transcript_entry = {
            "question_index": current_idx,
            "question": current_question["question"],
            "dimension": current_question.get("dimension", ""),
            "answer": req.answer,
            "is_followup": False,
        }

    updated_transcript = transcript_so_far + [transcript_entry]

    score_entry = {
        "scores": evaluation["scores"],
        "ai_generated_flag": evaluation.get("ai_generated_flag", False),
        "ai_confidence": evaluation.get("ai_confidence", "none"),
        "integrity_risk": integrity_summary["risk_level"],
        "integrity_flags": integrity_summary["flags"],
        "question_index": current_idx,
        "speech_metrics": speech_metrics_dict,
    }
    updated_scores = scores_so_far + [score_entry]
    new_idx = current_idx + 1

    # All questions answered → generate final report
    if new_idx >= len(questions):
        jd_info = (
            supabase.table("jd_posts").select("title").eq("id", jd_id).execute()
        )
        jd_title = jd_info.data[0]["title"] if jd_info.data else "this role"

        aggregate_speech = compute_aggregate_speech(updated_scores)
        report = await generate_report(updated_scores, jd_title, aggregate_speech)

        overall_integrity = compute_overall_integrity(updated_scores)
        report["integrity"] = overall_integrity
        if aggregate_speech:
            report["speech_metrics"] = aggregate_speech

        supabase.table("screening_sessions").update({
            "status": "completed",
            "current_question_index": new_idx,
            "scores_json": updated_scores,
            "transcript_json": updated_transcript,
            "report_json": report,
        }).eq("id", req.session_id).execute()

        return {
            "needs_followup": False,
            "follow_up_question": None,
            "next_question": None,
            "current_index": new_idx,
            "total_questions": len(questions),
            "is_complete": True,
            "final_score": report.get("overall_score"),
            "final_grade": report.get("overall_grade"),
            "headline": report.get("headline"),
        }

    # Advance to next question
    supabase.table("screening_sessions").update({
        "current_question_index": new_idx,
        "scores_json": updated_scores,
        "transcript_json": updated_transcript,
    }).eq("id", req.session_id).execute()

    next_q = questions[new_idx]
    return {
        "needs_followup": False,
        "follow_up_question": None,
        "next_question": {"id": next_q["id"], "question": next_q["question"]},
        "current_index": new_idx,
        "total_questions": len(questions),
        "is_complete": False,
    }


# ── 6. Recruiter: list completed sessions (auth required) ────────────────
@router.get("/results/{jd_id}")
async def get_screening_results(jd_id: str, client=Depends(get_authed_client)):
    sessions = (
        client.table("screening_sessions")
        .select(
            "id, candidate_name, candidate_email, status, report_json, "
            "resume_text, created_at, interview_mode, recruiter_decision, decided_at"
        )
        .eq("jd_id", jd_id)
        .eq("status", "completed")
        .order("created_at", desc=True)
        .execute()
    )

    results = []
    for s in sessions.data:
        report = s.get("report_json") or {}
        integrity = report.get("integrity") or {}
        results.append({
            "session_id": s["id"],
            "candidate_name": s["candidate_name"],
            "candidate_email": s["candidate_email"],
            "overall_score": report.get("overall_score"),
            "overall_grade": report.get("overall_grade"),
            "hire_recommendation": report.get("hire_recommendation"),
            "headline": report.get("headline"),
            "integrity_risk": integrity.get("overall_risk", "none"),
            "integrity_verdict": integrity.get("verdict", ""),
            "interview_mode": s.get("interview_mode", "text_only"),
            "recruiter_decision": s.get("recruiter_decision"),
            "decided_at": s.get("decided_at"),
            "created_at": s["created_at"],
            "resume_text": s.get("resume_text") or "",
        })
    return {"results": results}


# ── 7. Recruiter: full report + transcript (auth required) ───────────────
@router.get("/session-detail/{session_id}")
async def get_session_detail(session_id: str, client=Depends(get_authed_client)):
    session = (
        client.table("screening_sessions")
        .select(
            "id, candidate_name, candidate_email, report_json, integrity_agreement, "
            "created_at, interview_mode, transcript_json, scores_json, "
            "recruiter_decision, decision_reason, decided_at"
        )
        .eq("id", session_id)
        .execute()
    )
    if not session.data:
        raise HTTPException(status_code=404, detail="Session not found")

    s = session.data[0]
    return {
        "session_id": s["id"],
        "candidate_name": s["candidate_name"],
        "candidate_email": s["candidate_email"],
        "created_at": s["created_at"],
        "report": s.get("report_json") or {},
        "integrity_agreement": s.get("integrity_agreement") or {},
        "interview_mode": s.get("interview_mode", "text_only"),
        "transcript_json": s.get("transcript_json") or [],
        "scores_json": s.get("scores_json") or [],
        "recruiter_decision": s.get("recruiter_decision"),
        "decision_reason": s.get("decision_reason") or "",
        "decided_at": s.get("decided_at"),
    }


# ── 8. Recruiter: save hiring decision (auth required) ───────────────────
@router.patch("/session-decision")
async def save_session_decision(
    req: SessionDecisionRequest,
    client=Depends(get_authed_client),
):
    # Use service-role client for the update so RLS UPDATE policy (true) applies cleanly
    result = (
        supabase.table("screening_sessions")
        .update({
            "recruiter_decision": req.decision,
            "decision_reason": req.reason,
            "decided_at": datetime.now(timezone.utc).isoformat(),
        })
        .eq("id", req.session_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Session not found")

    return {"success": True, "decision": req.decision}
