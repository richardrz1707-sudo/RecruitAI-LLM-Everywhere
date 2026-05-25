from typing import Optional, Dict, Any, List, Literal
from pydantic import BaseModel


class CandidateCreate(BaseModel):
    name: str
    email: str


class JDCreate(BaseModel):
    title: str
    jd_text: str
    department: str = ""
    location: str = ""


class ParseJDRequest(BaseModel):
    jd_id: str


class MatchRequest(BaseModel):
    jd_id: str
    candidate_ids: List[str]
    weights: Optional[Dict[str, float]] = None


class UpdateJDRequest(BaseModel):
    title: Optional[str] = None
    jd_text: Optional[str] = None
    department: Optional[str] = None
    location: Optional[str] = None
    status: Optional[str] = None


class InterviewMessage(BaseModel):
    role: str
    content: str


class InterviewSession(BaseModel):
    candidate_id: str
    jd_id: str
    messages: List[InterviewMessage]


class APIResponse(BaseModel):
    success: bool
    data: Optional[Dict[str, Any]] = None
    message: str


class DimensionScore(BaseModel):
    score: float
    reason: str
    matched: List[str]
    gaps: List[str]


class CandidateScoreResult(BaseModel):
    candidate_id: str
    candidate_name: str
    total_score: float
    recommendation: str
    overall_summary: str
    hard_skills_match: DimensionScore
    experience_fit: DimensionScore
    education_alignment: DimensionScore
    soft_skills_signals: DimensionScore
    industry_relevance: DimensionScore
    career_trajectory: DimensionScore


class ResumeAnalyseRequest(BaseModel):
    candidate_id: str
    jd_id: str
    force_refresh: bool = False


class WeakBullet(BaseModel):
    original: str
    rewritten: str


class ResumeScores(BaseModel):
    jd_match: float
    ats_score: float
    impact_score: float
    language_score: float
    structure_score: float


class ResumeAnalysisResult(BaseModel):
    candidate_id: str
    jd_id: str
    overall_grade: str
    overall_summary: str
    scores: ResumeScores
    weak_bullets: List[WeakBullet]
    coaching_tips: List[str]
    missing_keywords: List[str]
    from_cache: bool
    version: int


class CreateScreeningLinkRequest(BaseModel):
    jd_id: str
    interview_mode: Literal["text_only", "speech_only"] = "text_only"


class RegisterCandidateRequest(BaseModel):
    token: str
    candidate_name: str
    candidate_email: str
    resume_text: str = ""
    integrity_agreed: bool = False
    agreement_version: str = "1.0"
    agreed_at: Optional[str] = None


class IntegritySignals(BaseModel):
    time_to_first_keystroke_ms: Optional[int] = None
    total_response_time_ms: Optional[int] = None
    answer_word_count: Optional[int] = None
    was_pasted: bool = False
    paste_count: int = 0
    tab_switch_count: int = 0
    total_time_away_ms: Optional[int] = None


class SpeechMetrics(BaseModel):
    duration_seconds: Optional[float] = None
    word_count: Optional[int] = None
    filler_word_count: Optional[int] = None
    filler_words_used: Optional[List[str]] = None
    words_per_minute: Optional[float] = None
    final_transcript: Optional[str] = None


class ScreeningAnswerRequest(BaseModel):
    session_id: str
    question_id: int
    answer: str
    is_followup: bool = False
    integrity_signals: Optional[IntegritySignals] = None
    speech_metrics: Optional[SpeechMetrics] = None


class SessionDecisionRequest(BaseModel):
    session_id: str
    decision: Literal["advance", "reject", "hold"]
    reason: str = ""
