import { useState, useEffect, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  createJD, parseJD, getAllCandidates, matchCandidates,
  createScreeningLink, getScreeningLink, getScreeningResults,
  getScreeningSessionDetail, saveSessionDecision,
  getJDPosts, updateJD, archiveJD, duplicateJD, logout,
  createInvite, getApplicationsForJd, updateApplicationStatus,
  getCandidateResume, addCandidateManually, updateJdVisibility,
  previewInviteQuestions, saveInviteQuestions,
} from '../lib/api'
import { useAuthStore } from '../lib/auth'
import { toast } from '../components/Toast'
import LoadingSpinner from '../components/LoadingSpinner'
import CandidateScoreCard from '../components/CandidateScoreCard'

// ── Constants ─────────────────────────────────────────────────────────────

const WEIGHT_KEYS = [
  { key: 'hard_skills_match',    label: 'Hard Skills Match' },
  { key: 'experience_fit',       label: 'Experience Fit' },
  { key: 'education_alignment',  label: 'Education Alignment' },
  { key: 'soft_skills_signals',  label: 'Soft Skills Signals' },
  { key: 'industry_relevance',   label: 'Industry Relevance' },
  { key: 'career_trajectory',    label: 'Career Trajectory' },
]

const DEFAULT_WEIGHTS = {
  hard_skills_match: 30, experience_fit: 25, education_alignment: 10,
  soft_skills_signals: 15, industry_relevance: 12, career_trajectory: 8,
}

const HIRE_REC = {
  strong_yes: { label: 'Strong Yes', color: 'bg-green-100 text-green-700' },
  yes:        { label: 'Yes',        color: 'bg-teal-100 text-teal-700' },
  maybe:      { label: 'Maybe',      color: 'bg-amber-100 text-amber-700' },
  no:         { label: 'No',         color: 'bg-red-100 text-red-700' },
}

const GRADE_STYLES = {
  A: 'text-green-700 bg-green-100', B: 'text-teal-700 bg-teal-100',
  C: 'text-amber-700 bg-amber-100', D: 'text-red-700 bg-red-100',
  F: 'text-red-700 bg-red-100',
}

const INTEGRITY_DOT = {
  none:   { dot: 'bg-green-400',  label: 'Clean' },
  low:    { dot: 'bg-blue-400',   label: 'Low' },
  medium: { dot: 'bg-amber-400',  label: 'Review' },
  high:   { dot: 'bg-red-500',    label: 'Suspicious' },
}

const INTEGRITY_BANNER = {
  none:   { bg: 'bg-green-50 border-green-200',  text: 'text-green-800',  icon: '✓', message: 'No integrity concerns' },
  low:    { bg: 'bg-blue-50 border-blue-200',    text: 'text-blue-800',   icon: 'ℹ', message: 'Minor concern — see details below' },
  medium: { bg: 'bg-amber-50 border-amber-200',  text: 'text-amber-800',  icon: '⚠', message: 'Review recommended — flagged answers detected' },
  high:   { bg: 'bg-red-50 border-red-200',      text: 'text-red-800',    icon: '✗', message: 'Multiple concerns — manual review strongly recommended' },
}

const INTERVIEW_MODES = {
  text_only:   { label: 'Text Only',   description: 'Candidates type their answers.', icon: '⌨️' },
  speech_only: { label: 'Speech Only', description: 'Candidates must speak their answers.', icon: '🎙️' },
}

const DECISION_BADGE = {
  advance: { label: 'Advancing', color: 'bg-green-100 text-green-700' },
  reject:  { label: 'Rejected',  color: 'bg-red-100 text-red-700' },
  hold:    { label: 'On hold',   color: 'bg-amber-100 text-amber-700' },
}

const DIM_LABELS = {
  english_proficiency: 'English',
  answer_quality:      'Answer Quality',
  soft_skills:         'Soft Skills',
  job_fit:             'Job Fit',
}

// ── Shared sub-components ─────────────────────────────────────────────────

function FlagBadge({ flag }) {
  const config = {
    unusually_fast: { icon: '⚡', color: 'text-amber-700 bg-amber-50 border-amber-200' },
    tab_switching:  { icon: '👁',  color: 'text-amber-700 bg-amber-50 border-amber-200' },
    ai_generated:   { icon: '🤖', color: 'text-red-700 bg-red-50 border-red-200' },
  }
  const { icon, color } = config[flag.type] || { icon: '⚑', color: 'text-gray-700 bg-gray-50 border-gray-200' }
  return (
    <div className={`flex items-start gap-2 text-xs border rounded-lg px-3 py-2 ${color}`}>
      <span className="flex-shrink-0">{icon}</span>
      <span>{flag.detail}</span>
    </div>
  )
}

function MiniScoreBar({ label, score }) {
  const color = score >= 80 ? 'bg-green-500' : score >= 60 ? 'bg-amber-400' : 'bg-red-400'
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500 w-36 flex-shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-xs font-mono text-gray-700 w-6 text-right">{score}</span>
    </div>
  )
}

// ── Resume Viewer Modal ───────────────────────────────────────────────────

function ResumeViewerModal({ data, onClose }) {
  if (!data) return null
  const { name, email, resume_text, resume_url } = data
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative z-10 w-full max-w-2xl bg-white rounded-2xl shadow-2xl flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-gray-100 flex-shrink-0">
          <div>
            <h2 className="text-base font-bold text-gray-900">📄 {name}</h2>
            <p className="text-xs text-gray-400 mt-0.5">{email}</p>
          </div>
          <div className="flex items-center gap-2 ml-4">
            {resume_url && (
              <a
                href={resume_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs bg-teal-600 hover:bg-teal-700 text-white font-semibold px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
              >
                Open PDF ↗
              </a>
            )}
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 text-xl leading-none transition-colors flex-shrink-0"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {resume_text ? (
            <pre className="text-sm text-gray-700 whitespace-pre-wrap font-mono leading-relaxed bg-gray-50 rounded-xl p-4 border border-gray-100">
              {resume_text}
            </pre>
          ) : (
            <div className="text-center py-12 text-gray-400">
              <p className="text-3xl mb-3">📄</p>
              <p className="text-sm">No resume text available for this candidate.</p>
              {resume_url && (
                <a
                  href={resume_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 inline-block text-teal-600 hover:text-teal-700 text-sm font-medium underline"
                >
                  Open original file ↗
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Answer Review Panel ───────────────────────────────────────────────────

function AnswerReviewPanel({ sessionRow, detail, loadingDetail, jdTitle, onClose, onDecisionSaved, onViewResume }) {
  const [expandedScores, setExpandedScores] = useState({})
  const [notes, setNotes]                   = useState('')
  const [notesSaved, setNotesSaved]         = useState(false)
  const [decision, setDecision]             = useState('')
  const [decisionReason, setDecisionReason] = useState('')
  const [savingDecision, setSavingDecision] = useState(false)
  const [decisionSaved, setDecisionSaved]   = useState(false)
  const contentRef = useRef(null)

  useEffect(() => {
    if (!sessionRow?.session_id) return
    const saved = localStorage.getItem(`notes_${sessionRow.session_id}`)
    if (saved) setNotes(saved)
  }, [sessionRow?.session_id])

  useEffect(() => {
    if (detail) {
      setDecision(detail.recruiter_decision || '')
      setDecisionReason(detail.decision_reason || '')
    }
  }, [detail?.session_id]) // eslint-disable-line react-hooks/exhaustive-deps

  const dimAvgs = useMemo(() => {
    const scores = (detail?.scores_json || []).filter((s) => s?.scores)
    if (!scores.length) return {}
    return Object.fromEntries(
      Object.keys(DIM_LABELS).map((dim) => [
        dim,
        Math.round(scores.reduce((sum, s) => sum + (s.scores[dim] || 0), 0) / scores.length),
      ]),
    )
  }, [detail?.scores_json])

  const qaCards = useMemo(() => {
    if (!detail?.transcript_json?.length) return []
    const groups = {}
    ;(detail.transcript_json || []).forEach((entry) => {
      const idx = entry.question_index
      if (!groups[idx]) groups[idx] = []
      groups[idx].push(entry)
    })
    const scoresArr = detail.scores_json || []
    return Object.entries(groups)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([idx, entries]) => ({
        index: Number(idx),
        mainEntry: entries.find((e) => !e.is_followup) || entries[0],
        followupEntries: entries.filter((e) => e.is_followup),
        scoreEntry: scoresArr.find((s) => s.question_index === Number(idx)) || null,
      }))
  }, [detail?.transcript_json, detail?.scores_json])

  const handleScorePillClick = (dimension) => {
    const scores = (detail?.scores_json || []).filter((s) => s?.scores)
    if (!scores.length || !contentRef.current) return
    let lowestIdx = scores[0].question_index
    let lowestScore = scores[0].scores?.[dimension] ?? Infinity
    scores.forEach((s) => {
      const sc = s.scores?.[dimension] ?? Infinity
      if (sc < lowestScore) { lowestScore = sc; lowestIdx = s.question_index }
    })
    const el = contentRef.current.querySelector(`[data-qa-card="${lowestIdx}"]`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const handleSaveNotes = () => {
    localStorage.setItem(`notes_${sessionRow.session_id}`, notes)
    setNotesSaved(true)
    setTimeout(() => setNotesSaved(false), 2500)
  }

  const handleSaveDecision = async () => {
    if (!decision) return
    setSavingDecision(true)
    try {
      await saveSessionDecision(sessionRow.session_id, decision, decisionReason)
      onDecisionSaved(sessionRow.session_id, decision)
      setDecisionSaved(true)
      setTimeout(() => setDecisionSaved(false), 3000)
      toast.success('Decision saved')
    } catch {
      toast.error('Failed to save decision')
    } finally {
      setSavingDecision(false)
    }
  }

  const toggleScores = (key) => setExpandedScores((prev) => ({ ...prev, [key]: !prev[key] }))

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black bg-opacity-40" onClick={onClose} />
      <div className="relative z-10 w-full max-w-[680px] bg-white h-full flex flex-col shadow-2xl">

        {/* Fixed header */}
        <div className="flex-shrink-0 bg-white border-b border-gray-200 px-6 py-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-gray-900 truncate">
              Interview Review — {detail?.candidate_name || '…'}
            </h2>
            <p className="text-xs text-gray-400 truncate">{detail?.candidate_email}</p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {onViewResume && detail?.resume_text && (
              <button
                onClick={onViewResume}
                className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium px-2.5 py-1.5 rounded-lg transition-colors whitespace-nowrap"
              >
                📄 Resume
              </button>
            )}
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none mt-0.5 transition-colors">✕</button>
          </div>
        </div>

        {/* Sub-header */}
        {detail && (
          <div className="flex-shrink-0 bg-gray-50 border-b border-gray-100 px-6 py-2.5 flex items-center gap-2.5 flex-wrap text-xs text-gray-500">
            <span className="font-medium text-gray-700 max-w-[160px] truncate">{jdTitle}</span>
            <span className="text-gray-300">|</span>
            <span className="bg-teal-100 text-teal-700 font-medium px-2 py-0.5 rounded-full">
              {INTERVIEW_MODES[detail.interview_mode || 'text_only']?.icon}{' '}
              {INTERVIEW_MODES[detail.interview_mode || 'text_only']?.label}
            </span>
            <span className="text-gray-300">|</span>
            <span>{new Date(detail.created_at).toLocaleDateString()}</span>
            <span className="text-gray-300">|</span>
            <span className={`font-bold px-2 py-0.5 rounded text-xs ${GRADE_STYLES[sessionRow?.overall_grade] || 'bg-gray-100 text-gray-600'}`}>
              {sessionRow?.overall_grade || '—'} · {sessionRow?.overall_score ?? '—'}/100
            </span>
          </div>
        )}

        {/* Scrollable body */}
        <div ref={contentRef} className="flex-1 overflow-y-auto">
          {loadingDetail ? (
            <LoadingSpinner label="Loading interview data…" />
          ) : !detail ? (
            <div className="flex items-center justify-center h-48 text-sm text-gray-400">Could not load interview data.</div>
          ) : (
            <div className="p-6 space-y-8">

              {/* Score overview */}
              {Object.keys(dimAvgs).length > 0 && (
                <div className="bg-gray-50 rounded-xl p-4">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Performance Overview</p>
                  <div className="grid grid-cols-4 gap-2">
                    {Object.entries(DIM_LABELS).map(([dim, label]) => {
                      const score = dimAvgs[dim]
                      if (score === undefined) return null
                      const cls = score >= 80
                        ? 'bg-green-100 text-green-800 hover:bg-green-200'
                        : score >= 60
                        ? 'bg-amber-100 text-amber-800 hover:bg-amber-200'
                        : 'bg-red-100 text-red-800 hover:bg-red-200'
                      return (
                        <button key={dim} onClick={() => handleScorePillClick(dim)}
                          title={`Jump to lowest ${label} answer`}
                          className={`text-center p-3 rounded-xl transition-colors ${cls}`}>
                          <p className="text-xl font-bold leading-none">{score}</p>
                          <p className="text-xs mt-1 leading-tight font-medium">{label}</p>
                        </button>
                      )
                    })}
                  </div>
                  <p className="text-xs text-gray-400 mt-2">Click a score to jump to the lowest-scoring answer in that dimension</p>
                </div>
              )}

              {/* Transcript */}
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2 border-b border-gray-100 pb-2">
                  Full Transcript
                  <span className="text-xs font-normal text-gray-400">({qaCards.length} question{qaCards.length !== 1 ? 's' : ''})</span>
                </h3>

                {qaCards.length === 0 ? (
                  <div className="text-center py-10 text-sm text-gray-400 border border-dashed border-gray-200 rounded-xl">
                    No transcript available for this session.
                    <br />
                    <span className="text-xs">Transcripts are recorded for sessions completed after this feature was enabled.</span>
                  </div>
                ) : (
                  <div className="space-y-8">
                    {qaCards.map((card) => {
                      const { index, mainEntry, followupEntries, scoreEntry } = card
                      const scores = scoreEntry?.scores || {}
                      const hasFlags = (scoreEntry?.integrity_flags?.length || 0) > 0
                      const hasSpeech = detail.interview_mode !== 'text_only' && scoreEntry?.speech_metrics
                      const intRisk = scoreEntry?.integrity_risk
                      const scoreKey = `q${index}`
                      const primaryDim = mainEntry?.dimension
                      const primaryScore = (primaryDim && scores[primaryDim] !== undefined) ? scores[primaryDim] : null
                      const totalQs = detail.scores_json?.length || qaCards.length

                      return (
                        <div key={index} data-qa-card={index} className="space-y-2.5">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-bold text-gray-400 uppercase tracking-widest">Question {index + 1} of {totalQs}</span>
                              {mainEntry?.probes_skill && (
                                <span className="text-xs bg-teal-50 text-teal-700 px-2 py-0.5 rounded-full">
                                  {mainEntry.probes_skill}
                                </span>
                              )}
                            </div>
                            {primaryScore !== null && (
                              <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full ${primaryScore >= 80 ? 'bg-green-100 text-green-700' : primaryScore >= 60 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>
                                {DIM_LABELS[primaryDim]}: {primaryScore}
                              </span>
                            )}
                          </div>
                          <div className="h-px bg-gray-100" />
                          <div className="flex gap-2.5">
                            <span className="text-xs font-bold text-teal-600 w-5 flex-shrink-0 mt-0.5">Q</span>
                            <div className="flex-1 bg-gray-50 rounded-lg px-3 py-2.5 text-sm text-gray-700 leading-relaxed">{mainEntry?.question}</div>
                          </div>
                          <div className="flex gap-2.5">
                            <div className="w-5 flex-shrink-0 flex flex-col items-center gap-0.5 mt-0.5">
                              <span className="text-xs font-bold text-purple-600">A</span>
                              {detail.interview_mode !== 'text_only' && <span className="text-xs leading-none">🎤</span>}
                            </div>
                            <div className="flex-1 bg-white border border-gray-200 rounded-lg px-3 py-2.5 text-sm text-gray-700 leading-relaxed">{mainEntry?.answer}</div>
                          </div>

                          {Object.keys(scores).length > 0 && (
                            <div className="ml-7">
                              <button onClick={() => toggleScores(scoreKey)} className="text-xs text-gray-400 hover:text-indigo-600 flex items-center gap-1 transition-colors">
                                View scores {expandedScores[scoreKey] ? '▲' : '▾'}
                              </button>
                              {expandedScores[scoreKey] && (
                                <div className="mt-2 p-3 bg-gray-50 rounded-lg space-y-2">
                                  {Object.entries(DIM_LABELS).map(([dim, label]) =>
                                    scores[dim] !== undefined ? <MiniScoreBar key={dim} label={label} score={scores[dim]} /> : null
                                  )}
                                </div>
                              )}
                            </div>
                          )}

                          {hasFlags && (
                            <div className={`ml-7 border rounded-lg p-3 text-xs ${intRisk === 'suspicious' ? 'bg-red-50 border-red-200 text-red-700' : 'bg-amber-50 border-amber-200 text-amber-700'}`}>
                              <p className="font-semibold mb-1.5">⚠ Integrity flags detected:</p>
                              <ul className="space-y-0.5">{scoreEntry.integrity_flags.map((flag, fi) => <li key={fi}>• {flag.detail}</li>)}</ul>
                            </div>
                          )}

                          {hasSpeech && (
                            <div className="ml-7 flex items-center gap-4 text-xs text-gray-400 flex-wrap">
                              {scoreEntry.speech_metrics.duration_seconds != null && (
                                <span>⏱ {Math.floor(scoreEntry.speech_metrics.duration_seconds / 60)}:{String(Math.floor(scoreEntry.speech_metrics.duration_seconds % 60)).padStart(2, '0')}</span>
                              )}
                              {scoreEntry.speech_metrics.word_count != null && <span>📝 {scoreEntry.speech_metrics.word_count} words</span>}
                              {scoreEntry.speech_metrics.words_per_minute != null && <span>🚀 {scoreEntry.speech_metrics.words_per_minute} WPM</span>}
                              {scoreEntry.speech_metrics.filler_word_count != null && (
                                <span>💬 Filler words: {scoreEntry.speech_metrics.filler_word_count}{scoreEntry.speech_metrics.filler_words_used?.length > 0 && ` (${scoreEntry.speech_metrics.filler_words_used.join(', ')})`}</span>
                              )}
                            </div>
                          )}

                          {followupEntries.map((fup, fi) => (
                            <div key={fi} className="ml-6 pl-4 border-l-2 border-amber-200 space-y-2">
                              <p className="text-xs font-semibold text-amber-600">↳ Follow-up question</p>
                              <div className="flex gap-2.5">
                                <span className="text-xs font-bold text-teal-600 w-5 flex-shrink-0 mt-0.5">Q</span>
                                <div className="flex-1 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2.5 text-sm text-gray-700 leading-relaxed">{fup.question}</div>
                              </div>
                              <div className="flex gap-2.5">
                                <span className="text-xs font-bold text-purple-600 w-5 flex-shrink-0 mt-0.5">A</span>
                                <div className="flex-1 bg-white border border-amber-100 rounded-lg px-3 py-2.5 text-sm text-gray-700 leading-relaxed">{fup.answer}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Recruiter notes */}
              <div className="space-y-3 border-t border-gray-100 pt-6">
                <div>
                  <h3 className="text-sm font-semibold text-gray-700">Recruiter Notes</h3>
                  <p className="text-xs text-gray-400 mt-0.5">Saved in your browser only — not visible to the candidate.</p>
                </div>
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4}
                  placeholder="Type private notes about this candidate…"
                  className="w-full border border-gray-300 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent resize-y" />
                <div className="flex items-center gap-3">
                  <button onClick={handleSaveNotes} className="bg-gray-800 hover:bg-gray-900 text-white font-medium px-4 py-2 rounded-lg text-sm transition-colors">
                    Save Notes
                  </button>
                  {notesSaved && <span className="text-xs text-gray-500">✓ Saved locally</span>}
                </div>
              </div>

              {/* Decision */}
              <div className="space-y-4 border-t border-gray-100 pt-6 pb-8">
                <div>
                  <h3 className="text-sm font-semibold text-gray-700">Your Decision</h3>
                  <p className="text-xs text-gray-400 mt-0.5">Move to next round?</p>
                </div>
                <div className="flex gap-2">
                  {[
                    { value: 'advance', label: '✓ Advance', on: 'bg-green-600 border-green-600 text-white', off: 'border-gray-200 text-gray-700 hover:border-green-300' },
                    { value: 'reject',  label: '✗ Reject',  on: 'bg-red-600 border-red-600 text-white',   off: 'border-gray-200 text-gray-700 hover:border-red-300' },
                    { value: 'hold',    label: '? Hold',     on: 'bg-amber-500 border-amber-500 text-white', off: 'border-gray-200 text-gray-700 hover:border-amber-300' },
                  ].map(({ value, label, on, off }) => (
                    <button key={value} onClick={() => setDecision(value)}
                      className={`flex-1 py-2.5 rounded-lg text-sm font-semibold border-2 transition-colors ${decision === value ? on : off}`}>
                      {label}
                    </button>
                  ))}
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Optional reason (internal only)</label>
                  <input type="text" value={decisionReason} onChange={(e) => setDecisionReason(e.target.value)}
                    placeholder="Add a note about your decision…"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent" />
                </div>
                <div className="flex items-center gap-3">
                  <button onClick={handleSaveDecision} disabled={!decision || savingDecision}
                    className="bg-teal-600 hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium px-5 py-2 rounded-lg text-sm transition-colors flex items-center gap-2">
                    {savingDecision && <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" /></svg>}
                    Save Decision
                  </button>
                  {decisionSaved && <span className="text-xs text-green-600 font-medium">✓ Decision saved</span>}
                </div>
              </div>

            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── JD Sidebar item ───────────────────────────────────────────────────────

function JDSidebarItem({ jd, selected, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-3 hover:bg-gray-50 transition-all duration-150 border-l-2 ${
        selected ? 'border-teal-500 bg-teal-50/60' : 'border-transparent'
      }`}
    >
      <div className="flex items-center gap-2 mb-0.5">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${jd.status === 'active' ? 'bg-green-500' : 'bg-gray-300'}`} />
        <p className="text-sm font-medium text-gray-800 truncate">{jd.title}</p>
      </div>
      {jd.department && <p className="text-xs text-gray-400 ml-4 truncate">{jd.department}</p>}
      <p className="text-xs text-gray-400 ml-4 mt-0.5">{jd.screening_count || 0} screened</p>
    </button>
  )
}

// ── New JD Modal ──────────────────────────────────────────────────────────

function NewJDModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ title: '', department: '', location: '', jd_text: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [step, setStep] = useState('idle') // 'idle' | 'saving' | 'parsing'

  const set = (k, v) => setForm((prev) => ({ ...prev, [k]: v }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!form.title.trim() || !form.jd_text.trim()) return
    setSaving(true)
    setError('')
    setStep('saving')
    try {
      const createRes = await createJD({
        title: form.title.trim(),
        jd_text: form.jd_text.trim(),
        department: form.department.trim(),
        location: form.location.trim(),
      })
      const jdId = createRes.data.data.id
      setStep('parsing')
      await parseJD(jdId)
      toast.success('Job description created and parsed!')
      onCreated(jdId)
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to create job description')
      setStep('idle')
    } finally {
      setSaving(false)
    }
  }

  const inputCls = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-40">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-bold text-gray-900">Create New Job Description</h2>
          <button onClick={onClose} disabled={saving} className="text-gray-400 hover:text-gray-600 text-xl leading-none transition-colors">✕</button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Job title <span className="text-red-500">*</span></label>
            <input value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Senior Frontend Engineer" required className={inputCls} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Department</label>
              <input value={form.department} onChange={(e) => set('department', e.target.value)} placeholder="Engineering" className={inputCls} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Location</label>
              <input value={form.location} onChange={(e) => set('location', e.target.value)} placeholder="Remote" className={inputCls} />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Job description <span className="text-red-500">*</span></label>
            <textarea value={form.jd_text} onChange={(e) => set('jd_text', e.target.value)}
              rows={8} placeholder="Paste or type your full job description here…" required className={`${inputCls} resize-y`} />
          </div>
          {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
          <div className="flex items-center justify-end gap-3 pt-1">
            <button type="button" onClick={onClose} disabled={saving}
              className="border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-50">
              Cancel
            </button>
            <button type="submit" disabled={saving || !form.title.trim() || !form.jd_text.trim()}
              className="bg-teal-600 hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium px-5 py-2 rounded-lg text-sm transition-colors flex items-center gap-2">
              {saving && <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" /></svg>}
              {step === 'parsing' ? 'Parsing with AI…' : step === 'saving' ? 'Saving…' : 'Save & Parse JD'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Main Dashboard ────────────────────────────────────────────────────────

export default function DashboardPage() {
  const navigate = useNavigate()
  const { fullName, clearUser } = useAuthStore()

  // JD library
  const [jdList, setJdList]               = useState([])
  const [loadingJds, setLoadingJds]       = useState(true)
  const [selectedJdId, setSelectedJdId]   = useState(null)
  const [showNewJdModal, setShowNewJdModal] = useState(false)
  const [showArchivedJds, setShowArchivedJds] = useState(false)

  // JD editing
  const [isEditing, setIsEditing]   = useState(false)
  const [editForm, setEditForm]     = useState({ title: '', department: '', location: '', jd_text: '' })
  const [savingEdit, setSavingEdit] = useState(false)
  const [jdPreviewOpen, setJdPreviewOpen] = useState(false)

  // Candidates (for matching)
  const [candidates, setCandidates]     = useState([])
  const [selectedIds, setSelectedIds]   = useState(new Set())
  const [weights, setWeights]           = useState({ ...DEFAULT_WEIGHTS })
  const [matching, setMatching]         = useState(false)
  const [matchResults, setMatchResults] = useState([])
  const [matchError, setMatchError]     = useState('')

  // Screening link
  const [screeningLink, setScreeningLink]       = useState(null)
  const [creatingLink, setCreatingLink]         = useState(false)
  const [linkCopied, setLinkCopied]             = useState(false)
  // Screening results
  const [screeningResults, setScreeningResults] = useState([])
  const [loadingResults, setLoadingResults]     = useState(false)

  // Full report panel
  const [selectedSession, setSelectedSession]     = useState(null)
  const [sessionDetail, setSessionDetail]         = useState(null)
  const [loadingDetail, setLoadingDetail]         = useState(false)
  const [integrityExpanded, setIntegrityExpanded] = useState(false)

  // Answer review panel
  const [reviewSession, setReviewSession] = useState(null)
  const [reviewDetail, setReviewDetail]   = useState(null)
  const [loadingReview, setLoadingReview] = useState(false)

  // Resume viewer modal
  const [resumeModal, setResumeModal] = useState(null) // null | { name, email, resume_text, resume_url }
  const openResume = (name, email, resume_text, resume_url = '') =>
    setResumeModal({ name, email, resume_text: resume_text || '', resume_url: resume_url || '' })

  // Applications (self-applicants per JD)
  const [applications, setApplications]           = useState([])
  const [loadingApplications, setLoadingApplications] = useState(false)
  // Track which candidate IDs have been invited this session (for instant UI feedback)
  const [invitedCandidateIds, setInvitedCandidateIds] = useState(new Set())
  const [questionPreview, setQuestionPreview] = useState(null)
  const [loadingQuestionPreview, setLoadingQuestionPreview] = useState(false)
  const [sendingPreviewInvite, setSendingPreviewInvite] = useState(false)

  // Resume slide-out panel (from candidate pool / applications)
  const [resumePanel, setResumePanel]   = useState(null) // null | {name,email,resume_text,resume_url}
  const [loadingResume, setLoadingResume] = useState(false)

  // Add candidate manually modal
  const [showAddCandidate, setShowAddCandidate]   = useState(false)
  const [addCandidateForm, setAddCandidateForm]   = useState({ name: '', email: '', resume: null })
  const [addingCandidate, setAddingCandidate]     = useState(false)
  const [addCandidateError, setAddCandidateError] = useState('')

  // Derived
  const selectedJd = jdList.find((j) => j.id === selectedJdId) || null
  const activeJds   = jdList.filter((j) => j.status === 'active')
  const archivedJds = jdList.filter((j) => j.status === 'archived')

  const normalisedForApi = useMemo(() => {
    const total = Object.values(weights).reduce((a, b) => a + b, 0) || 1
    return Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, v / total]))
  }, [weights])

  // ── Load JD list + candidates on mount ───────────────────────────────
  useEffect(() => {
    loadJdList()
    getAllCandidates()
      .then((r) => setCandidates(r.data?.data?.candidates || []))
      .catch(() => {})
  }, [])

  // ── Reload screening link + results when selected JD changes ─────────
  useEffect(() => {
    if (!selectedJdId) {
      setScreeningLink(null)
      setScreeningResults([])
      setMatchResults([])
      setSelectedSession(null)
      setSessionDetail(null)
      setApplications([])
      return
    }
    setIsEditing(false)
    setJdPreviewOpen(false)
    setMatchResults([])
    setMatchError('')
    setSelectedSession(null)
    setSessionDetail(null)

    getScreeningLink(selectedJdId)
      .then((r) => {
        if (r.data?.token) {
          setScreeningLink(r.data)
        } else {
          setScreeningLink(null)
        }
      })
      .catch(() => setScreeningLink(null))

    loadScreeningResults(selectedJdId)
    loadApplications(selectedJdId)
  }, [selectedJdId]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadJdList = async () => {
    setLoadingJds(true)
    try {
      const r = await getJDPosts('all')
      setJdList(r.data?.data?.jd_posts || [])
    } catch {
      toast.error('Failed to load job descriptions')
    } finally {
      setLoadingJds(false)
    }
  }

  const loadScreeningResults = (jdId) => {
    setLoadingResults(true)
    getScreeningResults(jdId)
      .then((r) => setScreeningResults(r.data?.results || []))
      .catch(() => {})
      .finally(() => setLoadingResults(false))
  }

  // ── JD CRUD ───────────────────────────────────────────────────────────
  const handleJdCreated = async (newJdId) => {
    setShowNewJdModal(false)
    await loadJdList()
    setSelectedJdId(newJdId)
  }

  const handleStartEdit = () => {
    if (!selectedJd) return
    setEditForm({
      title: selectedJd.title || '',
      department: selectedJd.department || '',
      location: selectedJd.location || '',
      jd_text: selectedJd.jd_text || '',
    })
    setIsEditing(true)
  }

  const handleSaveEdit = async () => {
    if (!selectedJdId) return
    setSavingEdit(true)
    try {
      const changes = {}
      if (editForm.title !== selectedJd.title) changes.title = editForm.title
      if (editForm.department !== (selectedJd.department || '')) changes.department = editForm.department
      if (editForm.location !== (selectedJd.location || '')) changes.location = editForm.location
      const jdTextChanged = editForm.jd_text.trim() !== (selectedJd.jd_text || '').trim()
      if (jdTextChanged) changes.jd_text = editForm.jd_text.trim()

      if (!Object.keys(changes).length) { setIsEditing(false); return }

      await updateJD(selectedJdId, changes)
      if (jdTextChanged) {
        await parseJD(selectedJdId)
        toast.success('JD updated and re-parsed!')
      } else {
        toast.success('JD updated!')
      }
      await loadJdList()
      setIsEditing(false)
    } catch {
      toast.error('Failed to update job description')
    } finally {
      setSavingEdit(false)
    }
  }

  const handleArchive = async () => {
    if (!selectedJdId) return
    if (!window.confirm(`Archive "${selectedJd?.title}"? It will be moved to Archived.`)) return
    try {
      await archiveJD(selectedJdId)
      toast.success('Job description archived')
      await loadJdList()
      setSelectedJdId(null)
    } catch {
      toast.error('Failed to archive')
    }
  }

  const handleDuplicate = async () => {
    if (!selectedJdId) return
    try {
      const r = await duplicateJD(selectedJdId)
      const newId = r.data?.data?.id
      toast.success('Job description duplicated!')
      await loadJdList()
      if (newId) setSelectedJdId(newId)
    } catch {
      toast.error('Failed to duplicate')
    }
  }

  // ── Logout ────────────────────────────────────────────────────────────
  const handleLogout = async () => {
    try { await logout() } catch { /* ignore */ }
    clearUser()
    navigate('/login', { replace: true })
  }

  // ── Candidate matching ────────────────────────────────────────────────
  const toggleCandidate = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  const toggleSelectAll = () => {
    if (selectedIds.size === candidates.length) setSelectedIds(new Set())
    else setSelectedIds(new Set(candidates.map((c) => c.id)))
  }
  const handleWeightChange = (key, value) => setWeights((prev) => ({ ...prev, [key]: Number(value) }))
  const handleRunMatching = async () => {
    if (!selectedIds.size || !selectedJdId) return
    setMatching(true)
    setMatchError('')
    setMatchResults([])
    try {
      const res = await matchCandidates(selectedJdId, [...selectedIds], normalisedForApi)
      setMatchResults(res.data?.data?.results || [])
    } catch {
      setMatchError('Matching failed. Please try again.')
      toast.error('Candidate matching failed')
    } finally {
      setMatching(false)
    }
  }

  // ── Screening link ────────────────────────────────────────────────────
  const handleCreateLink = async () => {
    if (!selectedJdId) return
    setCreatingLink(true)
    try {
      const r = await createScreeningLink(selectedJdId)
      setScreeningLink(r.data)
      toast.success('Screening link created!')
    } catch {
      toast.error('Failed to create screening link')
    } finally {
      setCreatingLink(false)
    }
  }
  const handleCopyLink = () => {
    if (!screeningLink?.url) return
    navigator.clipboard.writeText(screeningLink.url).then(() => {
      setLinkCopied(true)
      setTimeout(() => setLinkCopied(false), 2000)
      toast.success('Link copied to clipboard!')
    })
  }

  // ── Report / review ───────────────────────────────────────────────────
  const handleViewReport = async (sessionId) => {
    setSelectedSession(sessionId)
    setSessionDetail(null)
    setIntegrityExpanded(false)
    setLoadingDetail(true)
    try {
      const r = await getScreeningSessionDetail(sessionId)
      setSessionDetail(r.data)
    } catch {
      setSessionDetail(null)
      toast.error('Failed to load report')
    } finally {
      setLoadingDetail(false)
    }
  }
  const handleViewAnswers = async (sessionId) => {
    setReviewSession(sessionId)
    setReviewDetail(null)
    setLoadingReview(true)
    try {
      const r = await getScreeningSessionDetail(sessionId)
      setReviewDetail(r.data)
    } catch {
      setReviewDetail(null)
      toast.error('Failed to load interview data')
    } finally {
      setLoadingReview(false)
    }
  }
  const handleQuickDecision = async (sessionId, decision) => {
    setScreeningResults((prev) => prev.map((r) => r.session_id === sessionId ? { ...r, recruiter_decision: decision } : r))
    try {
      await saveSessionDecision(sessionId, decision, '')
    } catch {
      loadScreeningResults(selectedJdId)
      toast.error('Failed to save decision')
    }
  }
  const handleDecisionSaved = (sessionId, decision) => {
    setScreeningResults((prev) => prev.map((r) => r.session_id === sessionId ? { ...r, recruiter_decision: decision } : r))
  }

  // ── Applications ──────────────────────────────────────────────────────────
  const loadApplications = (jdId) => {
    setLoadingApplications(true)
    getApplicationsForJd(jdId)
      .then((r) => {
        const apps = r.data?.applications || []
        setApplications(apps)
        // Pre-populate the invited set from any already-invited applications
        const alreadyInvited = new Set(
          apps.filter((a) => a.status === 'invited').map((a) => a.candidates?.id).filter(Boolean)
        )
        setInvitedCandidateIds(alreadyInvited)
      })
      .catch(() => {})
      .finally(() => setLoadingApplications(false))
  }

  const handleVisibilityToggle = async (jdId, currentVisibility) => {
    const next = currentVisibility === 'open' ? 'invite_only' : 'open'
    try {
      await updateJdVisibility(jdId, next)
      setJdList((prev) => prev.map((j) => j.id === jdId ? { ...j, visibility: next } : j))
      toast.success(`JD is now ${next === 'open' ? 'publicly visible' : 'invite-only'}`)
    } catch {
      toast.error('Failed to update visibility')
    }
  }

  const handleViewResume = async (candidateId) => {
    setLoadingResume(true)
    setResumePanel(null)
    try {
      const r = await getCandidateResume(candidateId)
      setResumePanel(r.data)
    } catch {
      toast.error('Failed to load resume')
    } finally {
      setLoadingResume(false)
    }
  }

  const getCandidateDisplayName = (candidateId) =>
      applications.find((a) => a.candidates?.id === candidateId)?.candidates?.name ||
      candidates.find((c) => c.id === candidateId)?.name ||
      matchResults.find((m) => m.candidate_id === candidateId)?.candidate_name ||
      'Candidate'

  const sendInvite = async (candidateId, jdId, candidateName) => {
    // Optimistic update: mark as invited in applications list immediately
    setApplications((prev) =>
      prev.map((a) =>
        a.candidates?.id === candidateId ? { ...a, status: 'invited' } : a
      )
    )
    setInvitedCandidateIds((prev) => new Set([...prev, candidateId]))

    try {
      await createInvite(candidateId, jdId)
      toast.success(`Invite sent to ${candidateName}`)
      return true
    } catch (err) {
      // Revert optimistic updates on failure
      setApplications((prev) =>
        prev.map((a) =>
          a.candidates?.id === candidateId ? { ...a, status: 'applied' } : a
        )
      )
      setInvitedCandidateIds((prev) => {
        const next = new Set(prev)
        next.delete(candidateId)
        return next
      })
      toast.error(err.response?.data?.detail || 'Failed to send invite')
      return false
    }
  }

  const handleInvite = async (candidateId, jdId) => {
    setLoadingQuestionPreview(true)
    setQuestionPreview({
      candidateId,
      jdId,
      candidateName: getCandidateDisplayName(candidateId),
      jdTitle: selectedJd?.title || '',
      questions: [],
    })
    try {
      const res = await previewInviteQuestions(candidateId, jdId)
      setQuestionPreview({
        candidateId,
        jdId,
        candidateName: res.data?.candidate_name || getCandidateDisplayName(candidateId),
        jdTitle: res.data?.jd_title || selectedJd?.title || '',
        questions: res.data?.questions || [],
      })
    } catch (err) {
      setQuestionPreview(null)
      toast.error(err.response?.data?.detail || 'Failed to load interview questions')
      if (window.confirm('Question preview failed. Send the invite without preview?')) {
        await sendInvite(candidateId, jdId, getCandidateDisplayName(candidateId))
      }
    } finally {
      setLoadingQuestionPreview(false)
    }
  }

  const handlePreviewQuestionChange = (index, value) => {
    setQuestionPreview((prev) => {
      if (!prev) return prev
      const questions = [...prev.questions]
      questions[index] = { ...questions[index], question: value }
      return { ...prev, questions }
    })
  }

  const handleSendPreviewInvite = async () => {
    if (!questionPreview) return
    const { candidateId, jdId, candidateName } = questionPreview
    const questions = questionPreview.questions || []
    if (questions.length !== 5 || questions.some((q) => !(q.question || '').trim())) {
      toast.error('Please keep all 5 interview questions filled in')
      return
    }

    setSendingPreviewInvite(true)
    try {
      await saveInviteQuestions(candidateId, jdId, questions)
      const sent = await sendInvite(candidateId, jdId, candidateName)
      if (sent) setQuestionPreview(null)
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to save interview questions')
    } finally {
      setSendingPreviewInvite(false)
    }
  }

  const handleAddCandidate = async (e) => {
    e.preventDefault()
    setAddingCandidate(true)
    setAddCandidateError('')
    try {
      const fd = new FormData()
      fd.append('name', addCandidateForm.name.trim())
      fd.append('email', addCandidateForm.email.trim())
      if (addCandidateForm.resume) fd.append('resume', addCandidateForm.resume)
      await addCandidateManually(fd)
      toast.success('Candidate added!')
      setShowAddCandidate(false)
      setAddCandidateForm({ name: '', email: '', resume: null })
      getAllCandidates()
        .then((r) => setCandidates(r.data?.data?.candidates || []))
        .catch(() => {})
    } catch (err) {
      setAddCandidateError(err.response?.data?.detail || 'Failed to add candidate')
    } finally {
      setAddingCandidate(false)
    }
  }

  const canRunMatch = selectedIds.size > 0 && !!selectedJdId && !matching

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="flex h-[calc(100vh-64px)] overflow-hidden bg-gray-50">

      {/* Answer Review Panel overlay */}
      {reviewSession && (
        <AnswerReviewPanel
          sessionRow={screeningResults.find((r) => r.session_id === reviewSession)}
          detail={reviewDetail}
          loadingDetail={loadingReview}
          jdTitle={selectedJd?.title || ''}
          onClose={() => { setReviewSession(null); setReviewDetail(null) }}
          onDecisionSaved={handleDecisionSaved}
          onViewResume={reviewDetail?.resume_text
            ? () => openResume(reviewDetail.candidate_name, reviewDetail.candidate_email, reviewDetail.resume_text)
            : null}
        />
      )}

      {questionPreview && (
        <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl border border-gray-200 shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-gray-900">Preview Interview Questions</h2>
                <p className="text-xs text-gray-500 mt-1 truncate">
                  {questionPreview.candidateName}
                  {questionPreview.jdTitle ? ` - ${questionPreview.jdTitle}` : ''}
                </p>
              </div>
              <button
                onClick={() => setQuestionPreview(null)}
                disabled={sendingPreviewInvite}
                className="text-xs text-gray-500 hover:text-gray-700 font-semibold"
              >
                Close
              </button>
            </div>

            <div className="p-5 overflow-y-auto space-y-3">
              {loadingQuestionPreview ? (
                <LoadingSpinner size="sm" label="Generating interview questions..." />
              ) : questionPreview.questions.length === 0 ? (
                <p className="text-sm text-gray-500">No questions available yet.</p>
              ) : (
                questionPreview.questions.map((q, index) => (
                  <div key={index}>
                    <label className="block text-xs font-semibold text-gray-600 mb-1">
                      Question {index + 1}
                    </label>
                    <textarea
                      value={q.question || ''}
                      onChange={(e) => handlePreviewQuestionChange(index, e.target.value)}
                      rows={3}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent resize-y"
                    />
                  </div>
                ))
              )}
            </div>

            <div className="px-5 py-4 border-t border-gray-100 flex items-center justify-end gap-3">
              <button
                onClick={() => setQuestionPreview(null)}
                disabled={sendingPreviewInvite}
                className="border border-gray-300 hover:bg-gray-50 disabled:opacity-50 text-gray-700 font-medium px-4 py-2 rounded-lg text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSendPreviewInvite}
                disabled={loadingQuestionPreview || sendingPreviewInvite || questionPreview.questions.length !== 5}
                className="bg-teal-600 hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium px-4 py-2 rounded-lg text-sm transition-colors"
              >
                {sendingPreviewInvite ? 'Sending...' : 'Save Questions & Send Invite'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Resume Viewer Modal */}
      {resumeModal && (
        <ResumeViewerModal data={resumeModal} onClose={() => setResumeModal(null)} />
      )}

      {/* Resume slide-out panel (candidate pool / applications) */}
      {(resumePanel || loadingResume) && (
        <div className="fixed inset-0 z-[60] flex justify-end">
          <div className="absolute inset-0 bg-black/50" onClick={() => setResumePanel(null)} />
          <div className="relative z-10 w-full max-w-xl bg-white h-full flex flex-col shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 flex-shrink-0">
              <div>
                <h2 className="text-base font-bold text-gray-900">📄 {resumePanel?.name || '…'}</h2>
                <p className="text-xs text-gray-400 mt-0.5">{resumePanel?.email}</p>
                {resumePanel?.headline && <p className="text-xs text-gray-500 mt-0.5">{resumePanel.headline}</p>}
              </div>
              <div className="flex items-center gap-2 ml-4">
                {resumePanel?.resume_url && (
                  <a href={resumePanel.resume_url} target="_blank" rel="noopener noreferrer"
                    className="text-xs bg-teal-600 hover:bg-teal-700 text-white font-semibold px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap">
                    Open PDF ↗
                  </a>
                )}
                <button onClick={() => setResumePanel(null)}
                  className="text-gray-400 hover:text-gray-600 text-xl leading-none transition-colors flex-shrink-0">
                  ✕
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              {loadingResume ? (
                <LoadingSpinner label="Loading resume…" />
              ) : resumePanel?.resume_text ? (
                <pre className="text-sm text-gray-700 whitespace-pre-wrap font-mono leading-relaxed bg-gray-50 rounded-xl p-4 border border-gray-100">
                  {resumePanel.resume_text}
                </pre>
              ) : (
                <div className="text-center py-12 text-gray-400">
                  <p className="text-3xl mb-3">📄</p>
                  <p className="text-sm">No resume text available for this candidate.</p>
                  {resumePanel?.resume_url && (
                    <a href={resumePanel.resume_url} target="_blank" rel="noopener noreferrer"
                      className="mt-3 inline-block text-teal-600 hover:text-teal-700 text-sm font-medium underline">
                      Open original file ↗
                    </a>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Add Candidate manually modal */}
      {showAddCandidate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="text-base font-bold text-gray-900">Add Candidate Manually</h2>
              <button onClick={() => setShowAddCandidate(false)}
                className="text-gray-400 hover:text-gray-600 text-xl leading-none transition-colors">✕</button>
            </div>
            <form onSubmit={handleAddCandidate} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Full Name <span className="text-red-500">*</span></label>
                <input value={addCandidateForm.name}
                  onChange={(e) => setAddCandidateForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder="Jane Smith" required
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email <span className="text-red-500">*</span></label>
                <input type="email" value={addCandidateForm.email}
                  onChange={(e) => setAddCandidateForm((p) => ({ ...p, email: e.target.value }))}
                  placeholder="jane@example.com" required
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Resume (PDF or DOCX)</label>
                <input type="file" accept=".pdf,.docx"
                  onChange={(e) => setAddCandidateForm((p) => ({ ...p, resume: e.target.files?.[0] || null }))}
                  className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-teal-50 file:text-teal-700 hover:file:bg-teal-100 cursor-pointer" />
              </div>
              {addCandidateError && (
                <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{addCandidateError}</p>
              )}
              <div className="flex items-center justify-end gap-3 pt-1">
                <button type="button" onClick={() => setShowAddCandidate(false)} disabled={addingCandidate}
                  className="border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-50">
                  Cancel
                </button>
                <button type="submit"
                  disabled={addingCandidate || !addCandidateForm.name.trim() || !addCandidateForm.email.trim()}
                  className="bg-teal-600 hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium px-5 py-2 rounded-lg text-sm transition-colors flex items-center gap-2">
                  {addingCandidate && (
                    <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                  )}
                  {addingCandidate ? 'Adding…' : 'Add Candidate'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* New JD Modal */}
      {showNewJdModal && (
        <NewJDModal onClose={() => setShowNewJdModal(false)} onCreated={handleJdCreated} />
      )}

      {/* ── Sidebar ─────────────────────────────────────────────────── */}
      <aside className="w-[268px] flex-shrink-0 bg-white border-r border-gray-200 flex flex-col overflow-hidden">
        {/* Sidebar header */}
        <div className="flex-shrink-0 px-4 py-3.5 border-b border-gray-100 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-gray-800 truncate">My Job Descriptions</h2>
          <button
            onClick={() => setShowNewJdModal(true)}
            className="flex-shrink-0 bg-teal-600 hover:bg-teal-700 text-white text-xs font-semibold px-2.5 py-1.5 rounded-lg transition-colors whitespace-nowrap"
          >
            + New JD
          </button>
        </div>

        {/* User info + logout */}
        <div className="flex-shrink-0 px-4 py-2.5 border-b border-gray-100 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-medium text-gray-700 truncate">
              {fullName ? `👋 ${fullName}` : 'Recruiter'}
            </p>
          </div>
          <button onClick={handleLogout} className="flex-shrink-0 text-xs text-gray-400 hover:text-red-500 transition-colors">
            Log out
          </button>
        </div>

        {/* JD list */}
        <div className="flex-1 overflow-y-auto py-1">
          {loadingJds ? (
            <LoadingSpinner size="sm" label="Loading JDs…" />
          ) : (
            <>
              {/* Active JDs */}
              {activeJds.length > 0 ? (
                <>
                  <p className="px-4 pt-3 pb-1 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Active ({activeJds.length})
                  </p>
                  {activeJds.map((jd) => (
                    <JDSidebarItem
                      key={jd.id}
                      jd={jd}
                      selected={selectedJdId === jd.id}
                      onClick={() => setSelectedJdId(jd.id)}
                    />
                  ))}
                </>
              ) : (
                <div className="px-4 py-8 text-center">
                  <p className="text-2xl mb-2">📋</p>
                  <p className="text-xs text-gray-500 mb-3">No job descriptions yet.</p>
                  <button
                    onClick={() => setShowNewJdModal(true)}
                    className="text-xs text-teal-600 hover:text-teal-700 font-semibold underline"
                  >
                    + Create your first JD
                  </button>
                </div>
              )}

              {/* Archived JDs */}
              {archivedJds.length > 0 && (
                <div className="mt-2">
                  <button
                    onClick={() => setShowArchivedJds((v) => !v)}
                    className="w-full px-4 py-2 flex items-center justify-between text-xs font-semibold text-gray-400 hover:text-gray-600 uppercase tracking-wider transition-colors"
                  >
                    <span>Archived ({archivedJds.length})</span>
                    <span>{showArchivedJds ? '▲' : '▾'}</span>
                  </button>
                  {showArchivedJds && archivedJds.map((jd) => (
                    <JDSidebarItem
                      key={jd.id}
                      jd={jd}
                      selected={selectedJdId === jd.id}
                      onClick={() => setSelectedJdId(jd.id)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </aside>

      {/* ── Main panel ──────────────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto">
        {!selectedJd ? (
          /* Empty state */
          <div className="flex flex-col items-center justify-center h-full text-center p-8">
            <p className="text-5xl mb-4">🎯</p>
            <h2 className="text-xl font-semibold text-gray-800 mb-2">Select a job description</h2>
            <p className="text-sm text-gray-500 mb-6 max-w-sm">
              Choose a JD from the sidebar to view AI screening results, manage candidates, and send interview links.
            </p>
            <button
              onClick={() => setShowNewJdModal(true)}
              className="bg-teal-600 hover:bg-teal-700 text-white font-medium px-5 py-2.5 rounded-lg text-sm transition-colors"
            >
              + Create your first JD
            </button>
          </div>
        ) : (
          <div className="p-6 space-y-6 max-w-5xl mx-auto">

            {/* ── JD Header ─────────────────────────────────────────── */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
              {isEditing ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Job Title</label>
                      <input value={editForm.title} onChange={(e) => setEditForm((p) => ({ ...p, title: e.target.value }))}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Department</label>
                        <input value={editForm.department} onChange={(e) => setEditForm((p) => ({ ...p, department: e.target.value }))}
                          placeholder="e.g. Engineering"
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Location</label>
                        <input value={editForm.location} onChange={(e) => setEditForm((p) => ({ ...p, location: e.target.value }))}
                          placeholder="e.g. Remote"
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent" />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Job Description Text</label>
                      <textarea value={editForm.jd_text} onChange={(e) => setEditForm((p) => ({ ...p, jd_text: e.target.value }))}
                        rows={6} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent resize-y" />
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <button onClick={handleSaveEdit} disabled={savingEdit}
                      className="bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white font-medium px-4 py-2 rounded-lg text-sm transition-colors flex items-center gap-2">
                      {savingEdit && <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" /></svg>}
                      {savingEdit ? 'Saving…' : 'Save Changes'}
                    </button>
                    <button onClick={() => setIsEditing(false)} disabled={savingEdit}
                      className="border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium px-4 py-2 rounded-lg text-sm transition-colors">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h1 className="text-xl font-bold text-gray-900 truncate">{selectedJd.title}</h1>
                    <div className="flex items-center gap-2 mt-1 flex-wrap text-sm text-gray-500">
                      {selectedJd.department && <span>{selectedJd.department}</span>}
                      {selectedJd.department && selectedJd.location && <span>·</span>}
                      {selectedJd.location && <span>{selectedJd.location}</span>}
                      {(selectedJd.department || selectedJd.location) && <span className="text-gray-300">·</span>}
                      <span>Created {new Date(selectedJd.created_at).toLocaleDateString()}</span>
                      {selectedJd.status === 'archived' && (
                        <span className="bg-gray-100 text-gray-500 text-xs px-2 py-0.5 rounded-full font-medium">Archived</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
                    <button
                      onClick={() => handleVisibilityToggle(selectedJd.id, selectedJd.visibility)}
                      title={selectedJd.visibility === 'open' ? 'Visible to candidates — click to make invite-only' : 'Invite-only — click to make public'}
                      className={`text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors ${
                        selectedJd.visibility === 'open'
                          ? 'bg-green-50 border-green-300 text-green-700 hover:bg-green-100'
                          : 'bg-gray-100 border-gray-300 text-gray-600 hover:bg-gray-200'
                      }`}
                    >
                      {selectedJd.visibility === 'open' ? '🌐 Public' : '🔒 Invite-only'}
                    </button>
                    <button onClick={handleStartEdit}
                      className="border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium px-3 py-1.5 rounded-lg text-sm transition-colors">
                      Edit
                    </button>
                    {selectedJd.status === 'active' && (
                      <button onClick={handleArchive}
                        className="border border-gray-300 hover:bg-red-50 hover:border-red-300 hover:text-red-600 text-gray-700 font-medium px-3 py-1.5 rounded-lg text-sm transition-all duration-200">
                        Archive
                      </button>
                    )}
                    <button onClick={handleDuplicate}
                      className="border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium px-3 py-1.5 rounded-lg text-sm transition-colors">
                      Duplicate
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* ── Two-column: AI Screening + Matching ───────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

              {/* AI Screening */}
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-4">
                <h2 className="text-base font-semibold text-gray-900">AI Screening</h2>

                {!screeningLink ? (
                  <div className="space-y-4">
                    <div className="flex items-center gap-2">
                      <span className="text-xs bg-teal-100 text-teal-700 font-semibold px-2.5 py-0.5 rounded-full">🎙️ Speech interview</span>
                    </div>
                    <button onClick={handleCreateLink} disabled={creatingLink}
                      className="bg-teal-600 hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium px-4 py-2 rounded-lg text-sm transition-colors flex items-center gap-2">
                      {creatingLink ? <><svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" /></svg>Generating…</> : '🔗 Create Screening Link'}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs bg-teal-100 text-teal-700 font-semibold px-2.5 py-0.5 rounded-full">🎙️ Speech interview</span>
                    </div>
                    <p className="text-sm font-medium text-gray-700">Shareable link:</p>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 bg-teal-50 border border-teal-200 rounded-lg px-3 py-2 text-xs text-teal-700 font-mono truncate">
                        {screeningLink.url}
                      </div>
                      <button onClick={handleCopyLink}
                        className={`flex-shrink-0 px-3 py-2 rounded-lg text-sm font-semibold border transition-colors ${linkCopied ? 'bg-green-50 border-green-300 text-green-700' : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'}`}>
                        {linkCopied ? '✓' : 'Copy'}
                      </button>
                    </div>
                    <p className="text-xs text-gray-400">Questions cached per role — generated once.</p>
                  </div>
                )}
              </div>

              {/* Candidate Matching */}
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-semibold text-gray-900">Candidate Matching</h2>
                  <button
                    onClick={() => setShowAddCandidate(true)}
                    className="text-xs bg-teal-600 hover:bg-teal-700 text-white font-semibold px-3 py-1.5 rounded-lg transition-colors"
                  >
                    + Add Candidate
                  </button>
                </div>
                {candidates.length === 0 ? (
                  <p className="text-sm text-gray-500">No candidates yet. Upload resumes from the Candidate Dashboard.</p>
                ) : (
                  <>
                    <div className="flex items-center justify-between">
                      <label className="flex items-center gap-2 cursor-pointer text-sm font-medium text-gray-700 select-none">
                        <input type="checkbox" checked={selectedIds.size === candidates.length} onChange={toggleSelectAll} className="w-4 h-4 accent-teal-600" />
                        Select All ({candidates.length})
                      </label>
                      <span className="text-xs text-gray-400">{selectedIds.size} selected</span>
                    </div>
                    <div className="divide-y divide-gray-100 border border-gray-200 rounded-lg max-h-40 overflow-y-auto">
                      {candidates.map((c) => (
                        <label key={c.id} className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50 cursor-pointer">
                          <input type="checkbox" checked={selectedIds.has(c.id)} onChange={() => toggleCandidate(c.id)} className="w-4 h-4 accent-teal-600 flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-800 truncate">{c.name}</p>
                            <p className="text-xs text-gray-400 truncate">{c.email}</p>
                          </div>
                          {(c.resume_text || c.resume_url) && (
                            <button
                              type="button"
                              onClick={(e) => { e.preventDefault(); openResume(c.name, c.email, c.resume_text, c.resume_url) }}
                              className="flex-shrink-0 text-gray-400 hover:text-teal-600 transition-colors text-base"
                              title="View Resume"
                            >
                              📄
                            </button>
                          )}
                        </label>
                      ))}
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-xs font-semibold text-gray-600">Scoring Weights</p>
                        <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">
                          Relative priority
                        </span>
                      </div>
                      <div className="space-y-2">
                        {WEIGHT_KEYS.map(({ key, label }) => (
                          <div key={key} className="flex items-center gap-2">
                            <span className="text-xs text-gray-500 w-32 flex-shrink-0">{label}</span>
                            <input type="range" min={0} max={100} value={weights[key]} onChange={(e) => handleWeightChange(key, e.target.value)} className="flex-1 accent-teal-500" />
                            <span className="text-xs font-mono w-7 text-right text-gray-700">{weights[key]}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {matchError && <p className="text-sm text-red-600">{matchError}</p>}
                    <button onClick={handleRunMatching} disabled={!canRunMatch}
                      className="bg-teal-600 hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium px-4 py-2 rounded-lg text-sm transition-colors flex items-center gap-2">
                      {matching ? <><svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" /></svg>Running AI Matching…</> : 'Run Matching'}
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* ── Self-Applicants ────────────────────────────────────── */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-gray-900">
                  Applications
                  {applications.length > 0 && (
                    <span className="ml-2 bg-blue-100 text-blue-700 text-xs px-2 py-0.5 rounded-full">{applications.length}</span>
                  )}
                </h2>
                <button onClick={() => loadApplications(selectedJdId)} disabled={loadingApplications}
                  className="text-xs text-gray-400 hover:text-gray-600 underline transition-colors">
                  {loadingApplications ? 'Refreshing…' : 'Refresh'}
                </button>
              </div>

              {loadingApplications ? (
                <LoadingSpinner size="sm" label="Loading applications…" />
              ) : applications.length === 0 ? (
                <div className="border border-dashed border-gray-200 rounded-xl p-8 text-center">
                  <p className="text-2xl mb-2">📥</p>
                  <p className="text-sm text-gray-500">No applications yet.</p>
                  <p className="text-xs text-gray-400 mt-1">
                    {selectedJd?.visibility === 'open'
                      ? 'Candidates can apply via the job board.'
                      : 'Make the JD public so candidates can self-apply.'}
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 text-left text-xs text-gray-400 font-semibold uppercase tracking-wide">
                        <th className="pb-2 pr-3">Candidate</th>
                        <th className="pb-2 pr-3">Status</th>
                        <th className="pb-2 pr-3">Applied</th>
                        <th className="pb-2 pr-3">Score</th>
                        <th className="pb-2"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {applications.map((app) => {
                        const cand = app.candidates || {}
                        const statusColors = {
                          applied:     'bg-blue-100 text-blue-700',
                          shortlisted: 'bg-green-100 text-green-700',
                          invited:     'bg-teal-100 text-teal-700',
                          rejected:    'bg-red-100 text-red-700',
                        }
                        return (
                          <tr key={app.id} className="hover:bg-gray-50 transition-colors">
                            <td className="py-3 pr-3">
                              <p className="font-medium text-gray-800">{cand.name || '—'}</p>
                              <p className="text-xs text-gray-400">{cand.email}</p>
                              {cand.headline && (
                                <p className="text-xs text-gray-400 truncate max-w-[180px]">{cand.headline}</p>
                              )}
                            </td>
                            <td className="py-3 pr-3">
                              <select
                                value={app.status}
                                onChange={async (e) => {
                                  const newStatus = e.target.value
                                  try {
                                    await updateApplicationStatus(app.id, newStatus)
                                    setApplications((prev) =>
                                      prev.map((a) => a.id === app.id ? { ...a, status: newStatus } : a)
                                    )
                                    toast.success('Status updated')
                                  } catch {
                                    toast.error('Failed to update status')
                                  }
                                }}
                                className={`text-xs font-semibold px-2 py-1 rounded-full border-0 cursor-pointer focus:ring-2 focus:ring-teal-500 ${statusColors[app.status] || 'bg-gray-100 text-gray-600'}`}
                              >
                                <option value="applied">Applied</option>
                                <option value="shortlisted">Shortlisted</option>
                                <option value="invited">Invited</option>
                                <option value="rejected">Rejected</option>
                              </select>
                            </td>
                            <td className="py-3 pr-3 text-xs text-gray-400">
                              {app.applied_at ? new Date(app.applied_at).toLocaleDateString() : '—'}
                            </td>
                            <td className="py-3 pr-3 text-xs text-gray-600 font-medium">
                              {app.match_score != null ? `${Math.round(app.match_score)}%` : '—'}
                            </td>
                            <td className="py-3">
                              <div className="flex items-center gap-2 whitespace-nowrap">
                                {cand.id && (
                                  <button onClick={() => handleViewResume(cand.id)}
                                    className="text-xs text-blue-600 hover:text-blue-800 font-semibold underline transition-colors">
                                    Resume
                                  </button>
                                )}
                                {app.status !== 'invited' && cand.id && (
                                  <>
                                    <span className="text-gray-300">|</span>
                                    <button onClick={() => handleInvite(cand.id, selectedJdId)}
                                      className="text-xs text-teal-600 hover:text-teal-800 font-semibold underline transition-colors">
                                      Invite
                                    </button>
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Match results */}
            {matchResults.length > 0 && (
              <div>
                <h2 className="text-base font-semibold text-gray-900 mb-4">
                  Ranked Shortlist
                  <span className="ml-2 text-sm font-normal text-gray-500">— {matchResults.length} candidates matched</span>
                </h2>
                <div className="space-y-4">
                  {matchResults.map((candidate, index) => {
                    const fullCand = candidates.find((c) => c.id === candidate.candidate_id)
                    return (
                      <CandidateScoreCard
                        key={candidate.candidate_id}
                        candidate={candidate}
                        rank={index + 1}
                        onViewResume={fullCand && (fullCand.resume_text || fullCand.resume_url)
                          ? () => openResume(fullCand.name, fullCand.email, fullCand.resume_text, fullCand.resume_url)
                          : null}
                        onInvite={() => handleInvite(candidate.candidate_id, selectedJdId)}
                        isInvited={invitedCandidateIds.has(candidate.candidate_id)}
                        weightsUsed={candidate.weights_used || null}
                      />
                    )
                  })}
                </div>
              </div>
            )}

            {/* ── Screening Results ──────────────────────────────────── */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-gray-900">
                  Candidates Screened
                  {screeningResults.length > 0 && (
                    <span className="ml-2 bg-teal-100 text-teal-700 text-xs px-2 py-0.5 rounded-full">{screeningResults.length}</span>
                  )}
                </h2>
                <button onClick={() => loadScreeningResults(selectedJdId)} disabled={loadingResults}
                  className="text-xs text-gray-400 hover:text-gray-600 underline transition-colors">
                  {loadingResults ? 'Refreshing…' : 'Refresh'}
                </button>
              </div>

              {loadingResults ? (
                <LoadingSpinner size="sm" label="Loading results…" />
              ) : screeningResults.length === 0 ? (
                <div className="border border-dashed border-gray-200 rounded-xl p-8 text-center">
                  <p className="text-2xl mb-2">🔗</p>
                  <p className="text-sm text-gray-500 mb-3">No candidates screened yet.</p>
                  {screeningLink && (
                    <button onClick={handleCopyLink}
                      className="text-sm text-teal-600 hover:text-teal-700 font-medium underline transition-colors">
                      Copy the screening link to share with candidates
                    </button>
                  )}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 text-left text-xs text-gray-400 font-semibold uppercase tracking-wide">
                        <th className="pb-2 pr-3">Candidate</th>
                        <th className="pb-2 pr-3">Score</th>
                        <th className="pb-2 pr-3">Grade</th>
                        <th className="pb-2 pr-3">Integrity</th>
                        <th className="pb-2 pr-3">Decision</th>
                        <th className="pb-2 pr-3">Recommendation</th>
                        <th className="pb-2 pr-3">Date</th>
                        <th className="pb-2"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {screeningResults.map((r) => {
                        const rec = HIRE_REC[r.hire_recommendation] || HIRE_REC.maybe
                        const gradeStyle = GRADE_STYLES[r.overall_grade] || GRADE_STYLES.F
                        const integrity = INTEGRITY_DOT[r.integrity_risk] || INTEGRITY_DOT.none
                        return (
                          <tr key={r.session_id} className={`hover:bg-gray-50 transition-colors ${selectedSession === r.session_id ? 'bg-teal-50/50' : ''}`}>
                            <td className="py-3 pr-3">
                              <p className="font-medium text-gray-800">{r.candidate_name}</p>
                              <p className="text-xs text-gray-400">{r.candidate_email}</p>
                            </td>
                            <td className="py-3 pr-3 font-bold text-gray-800">{r.overall_score ?? '—'}/100</td>
                            <td className="py-3 pr-3">
                              <span className={`inline-block text-xs font-bold px-2 py-0.5 rounded ${gradeStyle}`}>{r.overall_grade ?? '—'}</span>
                            </td>
                            <td className="py-3 pr-3">
                              <div className="group relative inline-flex items-center gap-1.5 cursor-default">
                                <div className={`w-2.5 h-2.5 rounded-full ${integrity.dot}`} />
                                <span className="text-xs text-gray-500">{integrity.label}</span>
                                {r.integrity_verdict && (
                                  <div className="absolute bottom-full left-0 mb-1 hidden group-hover:block z-10 w-56 bg-gray-900 text-white text-xs rounded-lg px-3 py-2 shadow-lg pointer-events-none">{r.integrity_verdict}</div>
                                )}
                              </div>
                            </td>
                            <td className="py-3 pr-3">
                              {r.recruiter_decision ? (
                                <span className={`inline-block text-xs font-semibold px-2.5 py-1 rounded-full ${DECISION_BADGE[r.recruiter_decision]?.color}`}>
                                  {DECISION_BADGE[r.recruiter_decision]?.label}
                                </span>
                              ) : (
                                <div className="flex items-center gap-1">
                                  <button onClick={() => handleQuickDecision(r.session_id, 'advance')} title="Advance" className="w-6 h-6 rounded-full bg-green-100 hover:bg-green-200 text-green-700 flex items-center justify-center text-xs font-bold transition-colors">✓</button>
                                  <button onClick={() => handleQuickDecision(r.session_id, 'reject')} title="Reject" className="w-6 h-6 rounded-full bg-red-100 hover:bg-red-200 text-red-700 flex items-center justify-center text-xs font-bold transition-colors">✗</button>
                                  <button onClick={() => handleQuickDecision(r.session_id, 'hold')} title="Hold" className="w-6 h-6 rounded-full bg-amber-100 hover:bg-amber-200 text-amber-700 flex items-center justify-center text-xs font-bold transition-colors">?</button>
                                </div>
                              )}
                            </td>
                            <td className="py-3 pr-3">
                              <span className={`inline-block text-xs font-semibold px-2.5 py-1 rounded-full ${rec.color}`}>{rec.label}</span>
                            </td>
                            <td className="py-3 pr-3 text-xs text-gray-400">{new Date(r.created_at).toLocaleDateString()}</td>
                            <td className="py-3">
                              <div className="flex items-center gap-2 whitespace-nowrap">
                                <button onClick={() => handleViewReport(r.session_id)} className="text-xs text-teal-600 hover:text-teal-800 font-semibold underline transition-colors">Full Report</button>
                                <span className="text-gray-300">|</span>
                                <button onClick={() => handleViewAnswers(r.session_id)} className="text-xs text-purple-600 hover:text-purple-800 font-semibold underline transition-colors">Review Answers</button>
                                {r.resume_text && (
                                  <>
                                    <span className="text-gray-300">|</span>
                                    <button onClick={() => openResume(r.candidate_name, r.candidate_email, r.resume_text)} className="text-xs text-blue-600 hover:text-blue-800 font-semibold underline transition-colors">Resume</button>
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Full report inline panel */}
            {selectedSession && (
              <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 space-y-5">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-800">Full Screening Report</h3>
                  <button onClick={() => { setSelectedSession(null); setSessionDetail(null) }} className="text-xs text-gray-400 hover:text-gray-600 transition-colors">✕ Close</button>
                </div>
                {loadingDetail ? (
                  <LoadingSpinner size="sm" label="Loading report…" />
                ) : sessionDetail ? (
                  <div className="space-y-5">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="text-sm font-semibold text-gray-800">{sessionDetail.candidate_name}</p>
                        <p className="text-xs text-gray-500">{sessionDetail.candidate_email}</p>
                        {sessionDetail.resume_text && (
                          <button
                            onClick={() => openResume(sessionDetail.candidate_name, sessionDetail.candidate_email, sessionDetail.resume_text)}
                            className="mt-1 text-xs text-blue-600 hover:text-blue-800 font-medium underline transition-colors"
                          >
                            📄 View Resume
                          </button>
                        )}
                      </div>
                      {(() => { const m = INTERVIEW_MODES[sessionDetail.interview_mode || 'text_only']; return m ? <span className="text-xs bg-teal-100 text-teal-700 font-semibold px-2.5 py-1 rounded-full">{m.icon} {m.label}</span> : null })()}
                    </div>

                    {(() => {
                      const ag = sessionDetail.integrity_agreement || {}
                      return <p className="text-xs text-gray-400">{ag.agreed ? `✓ Integrity agreement signed at ${new Date(ag.agreed_at).toLocaleString()} (v${ag.version})` : '⚠ Candidate did not complete the integrity agreement'}</p>
                    })()}

                    {sessionDetail.recruiter_decision && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-500">Decision:</span>
                        <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${DECISION_BADGE[sessionDetail.recruiter_decision]?.color}`}>{DECISION_BADGE[sessionDetail.recruiter_decision]?.label}</span>
                        {sessionDetail.decided_at && <span className="text-xs text-gray-400">— {new Date(sessionDetail.decided_at).toLocaleDateString()}</span>}
                      </div>
                    )}

                    {(() => {
                      const risk = sessionDetail.report?.integrity?.overall_risk || 'none'
                      const banner = INTEGRITY_BANNER[risk] || INTEGRITY_BANNER.none
                      return (
                        <div className={`border rounded-xl px-4 py-3 flex items-center gap-3 ${banner.bg}`}>
                          <span className={`text-base font-bold ${banner.text}`}>{banner.icon}</span>
                          <div className="flex-1">
                            <p className={`text-sm font-semibold ${banner.text}`}>{banner.message}</p>
                            {sessionDetail.report?.integrity?.verdict && risk !== 'none' && (
                              <p className={`text-xs mt-0.5 opacity-80 ${banner.text}`}>{sessionDetail.report.integrity.verdict}</p>
                            )}
                          </div>
                        </div>
                      )
                    })()}

                    {sessionDetail.report?.headline && (
                      <div className="bg-gray-50 rounded-lg p-3 border border-gray-100">
                        <p className="text-xs font-semibold text-gray-400 mb-1">HEADLINE</p>
                        <p className="text-sm text-gray-700 italic">"{sessionDetail.report.headline}"</p>
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-4">
                      {sessionDetail.report?.strengths?.length > 0 && (
                        <div className="bg-white rounded-lg p-3 border border-gray-100">
                          <p className="text-xs font-semibold text-green-600 mb-2">STRENGTHS</p>
                          <ul className="space-y-1">{sessionDetail.report.strengths.map((s, i) => <li key={i} className="text-xs text-gray-700 flex gap-1.5"><span className="text-green-500 flex-shrink-0">✓</span>{s}</li>)}</ul>
                        </div>
                      )}
                      {sessionDetail.report?.concerns?.length > 0 && (
                        <div className="bg-white rounded-lg p-3 border border-gray-100">
                          <p className="text-xs font-semibold text-amber-600 mb-2">CONCERNS</p>
                          <ul className="space-y-1">{sessionDetail.report.concerns.map((c, i) => <li key={i} className="text-xs text-gray-700 flex gap-1.5"><span className="text-amber-500 flex-shrink-0">⚠</span>{c}</li>)}</ul>
                        </div>
                      )}
                    </div>

                    {sessionDetail.report?.suggested_interview_topics?.length > 0 && (
                      <div className="bg-white rounded-lg p-3 border border-gray-100">
                        <p className="text-xs font-semibold text-teal-600 mb-2">SUGGESTED INTERVIEW TOPICS</p>
                        <div className="flex flex-wrap gap-2">{sessionDetail.report.suggested_interview_topics.map((t, i) => <span key={i} className="text-xs bg-teal-100 text-teal-700 px-2.5 py-1 rounded-full">{t}</span>)}</div>
                      </div>
                    )}

                    {(() => {
                      const mode = sessionDetail.interview_mode || 'text_only'
                      const speechAnalysis = sessionDetail.report?.speech_analysis
                      const speechMetrics = sessionDetail.report?.speech_metrics
                      if (mode === 'text_only' || (!speechAnalysis && !speechMetrics)) return null
                      return (
                        <div className="bg-white rounded-lg p-3 border border-gray-100">
                          <p className="text-xs font-semibold text-teal-600 mb-2">🎙 SPEECH ANALYSIS</p>
                          {speechAnalysis && <p className="text-xs text-gray-700 mb-3 italic">{speechAnalysis}</p>}
                          {speechMetrics && (
                            <div className="flex flex-wrap gap-4">
                              {speechMetrics.avg_wpm != null && <div className="text-center"><p className="text-base font-bold text-gray-800">{speechMetrics.avg_wpm}</p><p className="text-xs text-gray-400">Avg WPM</p></div>}
                              {speechMetrics.total_filler_words != null && <div className="text-center"><p className="text-base font-bold text-gray-800">{speechMetrics.total_filler_words}</p><p className="text-xs text-gray-400">Filler words</p></div>}
                              {speechMetrics.total_duration_seconds != null && <div className="text-center"><p className="text-base font-bold text-gray-800">{Math.round(speechMetrics.total_duration_seconds)}s</p><p className="text-xs text-gray-400">Total speech</p></div>}
                            </div>
                          )}
                        </div>
                      )
                    })()}

                    {(() => {
                      const perQ = sessionDetail.report?.integrity?.per_question || []
                      const flagged = perQ.filter((q) => q.flags?.length > 0)
                      if (!flagged.length) return null
                      return (
                        <div className="bg-white rounded-lg border border-gray-100 overflow-hidden">
                          <button onClick={() => setIntegrityExpanded((v) => !v)}
                            className="w-full flex items-center justify-between px-3 py-2.5 text-xs font-semibold text-teal-700 hover:bg-teal-50 transition-colors">
                            <span>🛡 Integrity Details <span className="ml-1.5 bg-teal-100 px-1.5 py-0.5 rounded-full">{flagged.length} flagged</span></span>
                            <span className="text-gray-400">{integrityExpanded ? '▲' : '▼'}</span>
                          </button>
                          {integrityExpanded && (
                            <div className="px-3 pb-3 space-y-3 border-t border-gray-100 pt-3">
                              {flagged.map((q) => {
                                const riskDot = INTEGRITY_DOT[q.integrity_risk] || INTEGRITY_DOT.none
                                return (
                                  <div key={q.question_index}>
                                    <div className="flex items-center gap-2 mb-1.5">
                                      <div className={`w-2 h-2 rounded-full ${riskDot.dot}`} />
                                      <p className="text-xs font-semibold text-gray-700">Question {q.question_index + 1}</p>
                                      <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${q.integrity_risk === 'suspicious' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>{riskDot.label}</span>
                                    </div>
                                    <div className="space-y-1.5 pl-4">{q.flags.map((flag, fi) => <FlagBadge key={fi} flag={flag} />)}</div>
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                ) : (
                  <p className="text-sm text-gray-500">Could not load report.</p>
                )}
              </div>
            )}

            {/* ── JD Preview ─────────────────────────────────────────── */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <button
                onClick={() => setJdPreviewOpen((v) => !v)}
                className="w-full flex items-center justify-between px-5 py-4 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
              >
                <span>JD Preview</span>
                <span className="text-gray-400 text-xs">{jdPreviewOpen ? '▲ Collapse' : '▾ Expand'}</span>
              </button>
              {jdPreviewOpen && (
                <div className="px-5 pb-5 border-t border-gray-100">
                  <pre className="mt-4 text-sm text-gray-600 whitespace-pre-wrap font-sans leading-relaxed">
                    {selectedJd.jd_text}
                  </pre>
                </div>
              )}
            </div>

          </div>
        )}
      </main>
    </div>
  )
}
