import { useState, useEffect, useMemo, useRef } from 'react'
import {
  createJD,
  parseJD,
  getAllCandidates,
  matchCandidates,
  createScreeningLink,
  getScreeningLink,
  getScreeningResults,
  getScreeningSessionDetail,
  saveSessionDecision,
} from '../lib/api'
import CandidateScoreCard from '../components/CandidateScoreCard'

// ── Constants ─────────────────────────────────────────────────────────────

const WEIGHT_KEYS = [
  { key: 'hard_skills_match', label: 'Hard Skills Match' },
  { key: 'experience_fit', label: 'Experience Fit' },
  { key: 'education_alignment', label: 'Education Alignment' },
  { key: 'soft_skills_signals', label: 'Soft Skills Signals' },
  { key: 'industry_relevance', label: 'Industry Relevance' },
  { key: 'career_trajectory', label: 'Career Trajectory' },
]

const DEFAULT_WEIGHTS = {
  hard_skills_match: 30,
  experience_fit: 25,
  education_alignment: 10,
  soft_skills_signals: 15,
  industry_relevance: 12,
  career_trajectory: 8,
}

const HIRE_REC = {
  strong_yes: { label: 'Strong Yes', color: 'bg-green-100 text-green-700' },
  yes: { label: 'Yes', color: 'bg-teal-100 text-teal-700' },
  maybe: { label: 'Maybe', color: 'bg-amber-100 text-amber-700' },
  no: { label: 'No', color: 'bg-red-100 text-red-700' },
}

const GRADE_STYLES = {
  A: 'text-green-700 bg-green-100',
  B: 'text-teal-700 bg-teal-100',
  C: 'text-amber-700 bg-amber-100',
  D: 'text-red-700 bg-red-100',
  F: 'text-red-700 bg-red-100',
}

const INTEGRITY_DOT = {
  none: { dot: 'bg-green-400', label: 'Clean' },
  low: { dot: 'bg-blue-400', label: 'Low' },
  medium: { dot: 'bg-amber-400', label: 'Review' },
  high: { dot: 'bg-red-500', label: 'Suspicious' },
}

const INTEGRITY_BANNER = {
  none: { bg: 'bg-green-50 border-green-200', text: 'text-green-800', icon: '✓', message: 'No integrity concerns' },
  low: { bg: 'bg-blue-50 border-blue-200', text: 'text-blue-800', icon: 'ℹ', message: 'Minor concern — see details below' },
  medium: { bg: 'bg-amber-50 border-amber-200', text: 'text-amber-800', icon: '⚠', message: 'Review recommended — flagged answers detected' },
  high: { bg: 'bg-red-50 border-red-200', text: 'text-red-800', icon: '✗', message: 'Multiple concerns — manual review strongly recommended' },
}

const INTERVIEW_MODES = {
  text_only: { label: 'Text Only', description: 'Candidates type their answers. Standard interview mode.', icon: '⌨️' },
  speech_only: { label: 'Speech Only', description: 'Candidates must speak their answers. Typing disabled.', icon: '🎙️' },
}

const DECISION_BADGE = {
  advance: { label: 'Advancing', color: 'bg-green-100 text-green-700' },
  reject: { label: 'Rejected', color: 'bg-red-100 text-red-700' },
  hold: { label: 'On hold', color: 'bg-amber-100 text-amber-700' },
}

const DIM_LABELS = {
  english_proficiency: 'English',
  answer_quality: 'Answer Quality',
  soft_skills: 'Soft Skills',
  job_fit: 'Job Fit',
}

// ── Small helpers ─────────────────────────────────────────────────────────

function FlagBadge({ flag }) {
  const config = {
    paste_detected: { icon: '📋', color: 'text-amber-700 bg-amber-50 border-amber-200' },
    unusually_fast: { icon: '⚡', color: 'text-amber-700 bg-amber-50 border-amber-200' },
    tab_switching:  { icon: '👁', color: 'text-amber-700 bg-amber-50 border-amber-200' },
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

function ModeSelectorCards({ selectedMode, onSelect }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {Object.entries(INTERVIEW_MODES).map(([mode, cfg]) => (
        <button
          key={mode}
          onClick={() => onSelect(mode)}
          className={`p-3 rounded-xl border-2 text-left transition-colors ${
            selectedMode === mode ? 'border-teal-500 bg-teal-50' : 'border-gray-200 hover:border-gray-300 bg-white'
          }`}
        >
          <div className="text-xl mb-1">{cfg.icon}</div>
          <div className="text-xs font-semibold text-gray-800">{cfg.label}</div>
          <div className="text-xs text-gray-500 mt-0.5 leading-snug">{cfg.description}</div>
        </button>
      ))}
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

// ── Answer Review Panel ───────────────────────────────────────────────────

function AnswerReviewPanel({ sessionRow, detail, loadingDetail, jdTitle, onClose, onDecisionSaved }) {
  const [expandedScores, setExpandedScores] = useState({})
  const [notes, setNotes] = useState('')
  const [notesSaved, setNotesSaved] = useState(false)
  const [decision, setDecision] = useState('')
  const [decisionReason, setDecisionReason] = useState('')
  const [savingDecision, setSavingDecision] = useState(false)
  const [decisionSaved, setDecisionSaved] = useState(false)
  const contentRef = useRef(null)

  // Load notes from localStorage and sync decision state when detail loads
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

  // Compute per-dimension averages from scores_json
  const dimAvgs = useMemo(() => {
    const scores = (detail?.scores_json || []).filter(s => s?.scores)
    if (!scores.length) return {}
    return Object.fromEntries(
      Object.keys(DIM_LABELS).map(dim => [
        dim,
        Math.round(scores.reduce((sum, s) => sum + (s.scores[dim] || 0), 0) / scores.length),
      ])
    )
  }, [detail?.scores_json])

  // Group transcript entries by question_index, attach score entry
  const qaCards = useMemo(() => {
    if (!detail?.transcript_json?.length) return []
    const groups = {}
    ;(detail.transcript_json || []).forEach(entry => {
      const idx = entry.question_index
      if (!groups[idx]) groups[idx] = []
      groups[idx].push(entry)
    })
    const scoresArr = detail.scores_json || []
    return Object.entries(groups)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([idx, entries]) => ({
        index: Number(idx),
        mainEntry: entries.find(e => !e.is_followup) || entries[0],
        followupEntries: entries.filter(e => e.is_followup),
        scoreEntry: scoresArr.find(s => s.question_index === Number(idx)) || null,
      }))
  }, [detail?.transcript_json, detail?.scores_json])

  // Scroll to the lowest-scoring answer for a given dimension
  const handleScorePillClick = (dimension) => {
    const scores = (detail?.scores_json || []).filter(s => s?.scores)
    if (!scores.length || !contentRef.current) return
    let lowestIdx = scores[0].question_index
    let lowestScore = scores[0].scores?.[dimension] ?? Infinity
    scores.forEach(s => {
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
    } catch {
      // silent
    } finally {
      setSavingDecision(false)
    }
  }

  const toggleScores = (key) => setExpandedScores(prev => ({ ...prev, [key]: !prev[key] }))

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black bg-opacity-40" onClick={onClose} />

      {/* Panel */}
      <div className="relative z-10 w-full max-w-[680px] bg-white h-full flex flex-col shadow-2xl">

        {/* Fixed header */}
        <div className="flex-shrink-0 bg-white border-b border-gray-200 px-6 py-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-gray-900 truncate">
              Interview Review — {detail?.candidate_name || '…'}
            </h2>
            <p className="text-xs text-gray-400 truncate">{detail?.candidate_email}</p>
          </div>
          <button onClick={onClose} className="flex-shrink-0 text-gray-400 hover:text-gray-600 text-xl leading-none mt-0.5">
            ✕
          </button>
        </div>

        {/* Subheader */}
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

        {/* Scrollable content */}
        <div ref={contentRef} className="flex-1 overflow-y-auto">
          {loadingDetail ? (
            <div className="flex items-center justify-center h-48 gap-2 text-sm text-gray-400">
              <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              Loading interview data…
            </div>
          ) : !detail ? (
            <div className="flex items-center justify-center h-48 text-sm text-gray-400">
              Could not load interview data.
            </div>
          ) : (
            <div className="p-6 space-y-8">

              {/* ── Section 1: Scorecard strip ───────────────────────── */}
              {Object.keys(dimAvgs).length > 0 && (
                <div className="bg-gray-50 rounded-xl p-4">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
                    Performance Overview
                  </p>
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
                        <button
                          key={dim}
                          onClick={() => handleScorePillClick(dim)}
                          title={`Jump to lowest ${label} answer`}
                          className={`text-center p-3 rounded-xl transition-colors ${cls}`}
                        >
                          <p className="text-xl font-bold leading-none">{score}</p>
                          <p className="text-xs mt-1 leading-tight font-medium">{label}</p>
                        </button>
                      )
                    })}
                  </div>
                  <p className="text-xs text-gray-400 mt-2">
                    Click a score to jump to the lowest-scoring answer in that dimension
                  </p>
                </div>
              )}

              {/* ── Section 2: Full Transcript ───────────────────────── */}
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2 border-b border-gray-100 pb-2">
                  Full Transcript
                  <span className="text-xs font-normal text-gray-400">
                    ({qaCards.length} question{qaCards.length !== 1 ? 's' : ''})
                  </span>
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
                          {/* Card header */}
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-bold text-gray-400 uppercase tracking-widest">
                              Question {index + 1} of {totalQs}
                            </span>
                            {primaryScore !== null && (
                              <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full ${
                                primaryScore >= 80 ? 'bg-green-100 text-green-700'
                                : primaryScore >= 60 ? 'bg-amber-100 text-amber-700'
                                : 'bg-red-100 text-red-700'
                              }`}>
                                {DIM_LABELS[primaryDim]}: {primaryScore}
                              </span>
                            )}
                          </div>
                          <div className="h-px bg-gray-100" />

                          {/* Question */}
                          <div className="flex gap-2.5">
                            <span className="text-xs font-bold text-teal-600 w-5 flex-shrink-0 mt-0.5">Q</span>
                            <div className="flex-1 bg-gray-50 rounded-lg px-3 py-2.5 text-sm text-gray-700 leading-relaxed">
                              {mainEntry?.question}
                            </div>
                          </div>

                          {/* Answer */}
                          <div className="flex gap-2.5">
                            <div className="w-5 flex-shrink-0 flex flex-col items-center gap-0.5 mt-0.5">
                              <span className="text-xs font-bold text-purple-600">A</span>
                              {detail.interview_mode !== 'text_only' && (
                                <span className="text-xs leading-none">🎤</span>
                              )}
                            </div>
                            <div className="flex-1 bg-white border border-gray-200 rounded-lg px-3 py-2.5 text-sm text-gray-700 leading-relaxed">
                              {mainEntry?.answer}
                            </div>
                          </div>

                          {/* Collapsible score breakdown */}
                          {Object.keys(scores).length > 0 && (
                            <div className="ml-7">
                              <button
                                onClick={() => toggleScores(scoreKey)}
                                className="text-xs text-gray-400 hover:text-indigo-600 flex items-center gap-1 transition-colors"
                              >
                                View scores {expandedScores[scoreKey] ? '▲' : '▾'}
                              </button>
                              {expandedScores[scoreKey] && (
                                <div className="mt-2 p-3 bg-gray-50 rounded-lg space-y-2">
                                  {Object.entries(DIM_LABELS).map(([dim, label]) =>
                                    scores[dim] !== undefined ? (
                                      <MiniScoreBar key={dim} label={label} score={scores[dim]} />
                                    ) : null
                                  )}
                                </div>
                              )}
                            </div>
                          )}

                          {/* Integrity flags */}
                          {hasFlags && (
                            <div className={`ml-7 border rounded-lg p-3 text-xs ${
                              intRisk === 'suspicious'
                                ? 'bg-red-50 border-red-200 text-red-700'
                                : 'bg-amber-50 border-amber-200 text-amber-700'
                            }`}>
                              <p className="font-semibold mb-1.5">⚠ Integrity flags detected:</p>
                              <ul className="space-y-0.5">
                                {scoreEntry.integrity_flags.map((flag, fi) => (
                                  <li key={fi}>• {flag.detail}</li>
                                ))}
                              </ul>
                            </div>
                          )}

                          {/* Speech metrics strip */}
                          {hasSpeech && (
                            <div className="ml-7 flex items-center gap-4 text-xs text-gray-400 flex-wrap">
                              {scoreEntry.speech_metrics.duration_seconds != null && (
                                <span>
                                  ⏱ {Math.floor(scoreEntry.speech_metrics.duration_seconds / 60)}:{String(Math.floor(scoreEntry.speech_metrics.duration_seconds % 60)).padStart(2, '0')}
                                </span>
                              )}
                              {scoreEntry.speech_metrics.word_count != null && (
                                <span>📝 {scoreEntry.speech_metrics.word_count} words</span>
                              )}
                              {scoreEntry.speech_metrics.words_per_minute != null && (
                                <span>🚀 {scoreEntry.speech_metrics.words_per_minute} WPM</span>
                              )}
                              {scoreEntry.speech_metrics.filler_word_count != null && (
                                <span>
                                  💬 Filler words: {scoreEntry.speech_metrics.filler_word_count}
                                  {scoreEntry.speech_metrics.filler_words_used?.length > 0 &&
                                    ` (${scoreEntry.speech_metrics.filler_words_used.join(', ')})`
                                  }
                                </span>
                              )}
                            </div>
                          )}

                          {/* Follow-up entries */}
                          {followupEntries.map((fup, fi) => (
                            <div key={fi} className="ml-6 pl-4 border-l-2 border-amber-200 space-y-2">
                              <p className="text-xs font-semibold text-amber-600">↳ Follow-up question</p>
                              <div className="flex gap-2.5">
                                <span className="text-xs font-bold text-teal-600 w-5 flex-shrink-0 mt-0.5">Q</span>
                                <div className="flex-1 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2.5 text-sm text-gray-700 leading-relaxed">
                                  {fup.question}
                                </div>
                              </div>
                              <div className="flex gap-2.5">
                                <span className="text-xs font-bold text-purple-600 w-5 flex-shrink-0 mt-0.5">A</span>
                                <div className="flex-1 bg-white border border-amber-100 rounded-lg px-3 py-2.5 text-sm text-gray-700 leading-relaxed">
                                  {fup.answer}
                                </div>
                              </div>
                              {/* Scores for follow-up (same scoreEntry — it scored the follow-up) */}
                              {Object.keys(scores).length > 0 && (
                                <div className="ml-7">
                                  <button
                                    onClick={() => toggleScores(`${scoreKey}_fup${fi}`)}
                                    className="text-xs text-gray-400 hover:text-indigo-600 flex items-center gap-1"
                                  >
                                    View scores {expandedScores[`${scoreKey}_fup${fi}`] ? '▲' : '▾'}
                                  </button>
                                  {expandedScores[`${scoreKey}_fup${fi}`] && (
                                    <div className="mt-2 p-3 bg-amber-50 rounded-lg space-y-2">
                                      {Object.entries(DIM_LABELS).map(([dim, label]) =>
                                        scores[dim] !== undefined ? (
                                          <MiniScoreBar key={dim} label={label} score={scores[dim]} />
                                        ) : null
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* ── Section 3: Recruiter Notes ───────────────────────── */}
              <div className="space-y-3 border-t border-gray-100 pt-6">
                <div>
                  <h3 className="text-sm font-semibold text-gray-700">Recruiter Notes</h3>
                  <p className="text-xs text-gray-400 mt-0.5">
                    Saved in your browser only — not visible to the candidate.
                  </p>
                </div>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={4}
                  placeholder="Type private notes about this candidate…"
                  className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 resize-y"
                />
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleSaveNotes}
                    className="bg-gray-800 hover:bg-gray-900 text-white font-semibold px-4 py-2 rounded-lg text-sm transition-colors"
                  >
                    Save Notes
                  </button>
                  {notesSaved && <span className="text-xs text-gray-500">✓ Saved locally</span>}
                </div>
              </div>

              {/* ── Section 4: Decision ──────────────────────────────── */}
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
                    <button
                      key={value}
                      onClick={() => setDecision(value)}
                      className={`flex-1 py-2.5 rounded-lg text-sm font-semibold border-2 transition-colors ${decision === value ? on : off}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">
                    Optional reason (shown internally only)
                  </label>
                  <input
                    type="text"
                    value={decisionReason}
                    onChange={(e) => setDecisionReason(e.target.value)}
                    placeholder="Add a note about your decision…"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  />
                </div>

                <div className="flex items-center gap-3">
                  <button
                    onClick={handleSaveDecision}
                    disabled={!decision || savingDecision}
                    className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 text-white font-semibold px-5 py-2 rounded-lg text-sm transition-colors flex items-center gap-2"
                  >
                    {savingDecision && (
                      <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                      </svg>
                    )}
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

// ── Main Dashboard ────────────────────────────────────────────────────────

export default function HiringManagerDashboard() {
  // Section A
  const [jdTitle, setJdTitle] = useState('')
  const [jdText, setJdText] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedJd, setSavedJd] = useState(null)
  const [saveError, setSaveError] = useState('')

  // Section B
  const [candidates, setCandidates] = useState([])
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [weights, setWeights] = useState({ ...DEFAULT_WEIGHTS })

  // Section C
  const [matching, setMatching] = useState(false)
  const [matchResults, setMatchResults] = useState([])
  const [matchError, setMatchError] = useState('')

  // Section D — screening link
  const [screeningLink, setScreeningLink] = useState(null)
  const [creatingLink, setCreatingLink] = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)
  const [selectedMode, setSelectedMode] = useState('text_only')
  const [showModeSelector, setShowModeSelector] = useState(false)

  // Section D — results
  const [screeningResults, setScreeningResults] = useState([])
  const [loadingResults, setLoadingResults] = useState(false)

  // Full report panel
  const [selectedSession, setSelectedSession] = useState(null)
  const [sessionDetail, setSessionDetail] = useState(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [integrityExpanded, setIntegrityExpanded] = useState(false)

  // Answer review panel
  const [reviewSession, setReviewSession] = useState(null)
  const [reviewDetail, setReviewDetail] = useState(null)
  const [loadingReview, setLoadingReview] = useState(false)

  const weightTotal = useMemo(
    () => Object.values(weights).reduce((a, b) => a + b, 0),
    [weights],
  )

  useEffect(() => {
    getAllCandidates()
      .then((res) => setCandidates(res.data?.data?.candidates || []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!savedJd) return
    getScreeningLink(savedJd.id)
      .then((r) => {
        if (r.data?.token) {
          setScreeningLink(r.data)
          setSelectedMode(r.data.interview_mode || 'text_only')
        }
      })
      .catch(() => {})
    loadScreeningResults(savedJd.id)
  }, [savedJd])

  const loadScreeningResults = (jdId) => {
    setLoadingResults(true)
    getScreeningResults(jdId)
      .then((r) => setScreeningResults(r.data?.results || []))
      .catch(() => {})
      .finally(() => setLoadingResults(false))
  }

  // Section A
  const handleSaveJD = async () => {
    if (!jdTitle.trim() || !jdText.trim()) return
    setSaving(true)
    setSaveError('')
    try {
      const createRes = await createJD({ title: jdTitle, jd_text: jdText })
      const jdId = createRes.data.data.id
      const parseRes = await parseJD(jdId)
      const parsed = parseRes.data.parsed_jd || {}
      setSavedJd({ id: jdId, title: jdTitle, parsed_jd: parsed })
    } catch {
      setSaveError('Failed to save job description. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  // Section B
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

  const handleWeightChange = (key, value) =>
    setWeights((prev) => ({ ...prev, [key]: Number(value) }))

  const handleRunMatching = async () => {
    if (selectedIds.size === 0 || weightTotal !== 100 || !savedJd) return
    setMatching(true)
    setMatchError('')
    setMatchResults([])
    try {
      const weightsAsDecimals = Object.fromEntries(
        Object.entries(weights).map(([k, v]) => [k, v / 100]),
      )
      const res = await matchCandidates(savedJd.id, [...selectedIds], weightsAsDecimals)
      setMatchResults(res.data?.data?.results || [])
    } catch {
      setMatchError('Matching failed. Please try again.')
    } finally {
      setMatching(false)
    }
  }

  // Section D — link
  const handleCreateLink = async () => {
    if (!savedJd) return
    setCreatingLink(true)
    try {
      const r = await createScreeningLink(savedJd.id, selectedMode)
      setScreeningLink(r.data)
      setShowModeSelector(false)
    } catch {
      // silent
    } finally {
      setCreatingLink(false)
    }
  }

  const handleCopyLink = () => {
    if (!screeningLink?.url) return
    navigator.clipboard.writeText(screeningLink.url).then(() => {
      setLinkCopied(true)
      setTimeout(() => setLinkCopied(false), 2000)
    })
  }

  // Section D — full report
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
    } finally {
      setLoadingDetail(false)
    }
  }

  // Section D — answer review
  const handleViewAnswers = async (sessionId) => {
    setReviewSession(sessionId)
    setReviewDetail(null)
    setLoadingReview(true)
    try {
      const r = await getScreeningSessionDetail(sessionId)
      setReviewDetail(r.data)
    } catch {
      setReviewDetail(null)
    } finally {
      setLoadingReview(false)
    }
  }

  // Quick-decision from table row (optimistic)
  const handleQuickDecision = async (sessionId, decision) => {
    setScreeningResults((prev) =>
      prev.map((r) => r.session_id === sessionId ? { ...r, recruiter_decision: decision } : r)
    )
    try {
      await saveSessionDecision(sessionId, decision, '')
    } catch {
      loadScreeningResults(savedJd.id) // revert on failure
    }
  }

  // Called by review panel after a reasoned decision is saved
  const handleDecisionSaved = (sessionId, decision) => {
    setScreeningResults((prev) =>
      prev.map((r) => r.session_id === sessionId ? { ...r, recruiter_decision: decision } : r)
    )
  }

  const canRunMatch = selectedIds.size > 0 && weightTotal === 100 && !!savedJd && !matching

  return (
    <div className="max-w-4xl mx-auto px-4 py-10 space-y-10">

      {/* Answer Review Panel — rendered as overlay */}
      {reviewSession && (
        <AnswerReviewPanel
          sessionRow={screeningResults.find((r) => r.session_id === reviewSession)}
          detail={reviewDetail}
          loadingDetail={loadingReview}
          jdTitle={savedJd?.title || ''}
          onClose={() => { setReviewSession(null); setReviewDetail(null) }}
          onDecisionSaved={handleDecisionSaved}
        />
      )}

      <h1 className="text-3xl font-bold text-gray-900">Hiring Manager Dashboard</h1>

      {/* ── Section A ────────────────────────────────────────────────── */}
      <section className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
        <h2 className="text-xl font-semibold text-gray-800 mb-5">
          Step 1 — Create a Job Description
        </h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Job Title</label>
            <input
              type="text"
              value={jdTitle}
              onChange={(e) => setJdTitle(e.target.value)}
              placeholder="e.g. Senior Frontend Engineer"
              className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={!!savedJd}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Job Description</label>
            <textarea
              value={jdText}
              onChange={(e) => setJdText(e.target.value)}
              rows={8}
              placeholder="Paste the full job description here..."
              className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
              disabled={!!savedJd}
            />
          </div>
          {saveError && <p className="text-sm text-red-600">{saveError}</p>}
          {!savedJd ? (
            <button
              onClick={handleSaveJD}
              disabled={saving || !jdTitle.trim() || !jdText.trim()}
              className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white font-semibold px-6 py-2.5 rounded-lg text-sm transition-colors"
            >
              {saving ? 'Saving & Parsing…' : 'Save Job Description'}
            </button>
          ) : (
            <div className="flex items-center gap-3 bg-green-50 border border-green-200 rounded-lg px-4 py-3">
              <span className="text-green-600 text-lg">✓</span>
              <div>
                <p className="text-sm font-semibold text-green-800">Job description saved and parsed</p>
                <p className="text-xs text-green-600">Role: {savedJd.parsed_jd?.role_title || savedJd.title}</p>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ── Section B ────────────────────────────────────────────────── */}
      {savedJd && (
        <section className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
          <h2 className="text-xl font-semibold text-gray-800 mb-5">
            Step 2 — Select Candidates to Match
          </h2>
          {candidates.length === 0 ? (
            <p className="text-sm text-gray-500">
              No candidates found. Upload resumes from the Candidate Dashboard first.
            </p>
          ) : (
            <>
              <div className="mb-3 flex items-center justify-between">
                <label className="flex items-center gap-2 cursor-pointer select-none text-sm font-medium text-gray-700">
                  <input
                    type="checkbox"
                    checked={selectedIds.size === candidates.length}
                    onChange={toggleSelectAll}
                    className="w-4 h-4 accent-blue-600"
                  />
                  Select All ({candidates.length})
                </label>
                <span className="text-xs text-gray-400">{selectedIds.size} selected</span>
              </div>
              <div className="divide-y divide-gray-100 border border-gray-200 rounded-lg mb-6 max-h-64 overflow-y-auto">
                {candidates.map((c) => (
                  <label key={c.id} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(c.id)}
                      onChange={() => toggleCandidate(c.id)}
                      className="w-4 h-4 accent-blue-600 flex-shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-800 truncate">{c.name}</p>
                      <p className="text-xs text-gray-400 truncate">{c.email}</p>
                    </div>
                    <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full flex-shrink-0">
                      Resume uploaded
                    </span>
                  </label>
                ))}
              </div>
              <div className="mb-6">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-gray-700">Scoring Weights</h3>
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${weightTotal === 100 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                    Total: {weightTotal}/100
                  </span>
                </div>
                {weightTotal !== 100 && (
                  <p className="text-xs text-red-600 mb-3">Weights must sum to exactly 100 before running matching.</p>
                )}
                <div className="space-y-3">
                  {WEIGHT_KEYS.map(({ key, label }) => (
                    <div key={key} className="flex items-center gap-3">
                      <span className="text-xs text-gray-600 w-40 flex-shrink-0">{label}</span>
                      <input
                        type="range" min={0} max={100} value={weights[key]}
                        onChange={(e) => handleWeightChange(key, e.target.value)}
                        className="flex-1 accent-teal-500"
                      />
                      <span className="text-xs font-mono w-8 text-right text-gray-700">{weights[key]}</span>
                    </div>
                  ))}
                </div>
              </div>
              {matchError && <p className="text-sm text-red-600 mb-3">{matchError}</p>}
              <button
                onClick={handleRunMatching}
                disabled={!canRunMatch}
                className="bg-teal-600 hover:bg-teal-700 disabled:bg-gray-300 text-white font-semibold px-6 py-2.5 rounded-lg text-sm transition-colors flex items-center gap-2"
              >
                {matching && (
                  <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                )}
                {matching ? 'Running AI Matching…' : 'Run Matching'}
              </button>
            </>
          )}
        </section>
      )}

      {/* ── Section C ────────────────────────────────────────────────── */}
      {matchResults.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-xl font-semibold text-gray-800">Step 3 — Ranked Shortlist</h2>
            <span className="text-sm text-gray-500">
              {matchResults.length} candidates matched against{' '}
              <span className="font-medium text-gray-700">
                {savedJd.parsed_jd?.role_title || savedJd.title}
              </span>
            </span>
          </div>
          <div className="space-y-4">
            {matchResults.map((candidate, index) => (
              <CandidateScoreCard key={candidate.candidate_id} candidate={candidate} rank={index + 1} />
            ))}
          </div>
        </section>
      )}

      {/* ── Section D ────────────────────────────────────────────────── */}
      {savedJd && (
        <section className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-6">
          <div>
            <h2 className="text-xl font-semibold text-gray-800">Step 4 — AI Candidate Screening</h2>
            <p className="text-sm text-gray-500 mt-1">
              Generate a shareable link so candidates can complete an AI-powered interview.
            </p>
          </div>

          {/* Link creation / display */}
          {!screeningLink ? (
            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium text-gray-700 mb-2">Select interview mode for candidates:</p>
                <ModeSelectorCards selectedMode={selectedMode} onSelect={setSelectedMode} />
              </div>
              <button
                onClick={handleCreateLink}
                disabled={creatingLink}
                className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 text-white font-semibold px-5 py-2.5 rounded-lg text-sm transition-colors flex items-center gap-2"
              >
                {creatingLink && (
                  <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                )}
                {creatingLink ? 'Generating Link…' : '🔗 Create Screening Link'}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-medium text-gray-500">Mode:</span>
                <span className="text-xs bg-teal-100 text-teal-700 font-semibold px-2.5 py-0.5 rounded-full">
                  {INTERVIEW_MODES[screeningLink.interview_mode || 'text_only']?.icon}{' '}
                  {INTERVIEW_MODES[screeningLink.interview_mode || 'text_only']?.label || 'Text Only'}
                </span>
                <button
                  onClick={() => setShowModeSelector((v) => !v)}
                  className="text-xs text-gray-400 hover:text-gray-600 underline"
                >
                  {showModeSelector ? 'Cancel' : 'Change mode'}
                </button>
              </div>
              {showModeSelector && (
                <div className="space-y-3 p-4 bg-gray-50 rounded-xl border border-gray-200">
                  <ModeSelectorCards selectedMode={selectedMode} onSelect={setSelectedMode} />
                  <button
                    onClick={handleCreateLink}
                    disabled={creatingLink}
                    className="bg-teal-600 hover:bg-teal-700 disabled:bg-gray-300 text-white font-semibold px-4 py-2 rounded-lg text-sm transition-colors flex items-center gap-2"
                  >
                    {creatingLink && (
                      <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                      </svg>
                    )}
                    {creatingLink ? 'Saving…' : 'Save Mode'}
                  </button>
                </div>
              )}
              <p className="text-sm font-medium text-gray-700">Shareable screening link — send this to candidates:</p>
              <div className="flex items-center gap-3">
                <div className="flex-1 bg-indigo-50 border border-indigo-200 rounded-lg px-4 py-2.5 text-sm text-indigo-700 font-mono truncate">
                  {screeningLink.url}
                </div>
                <button
                  onClick={handleCopyLink}
                  className={`flex-shrink-0 px-4 py-2.5 rounded-lg text-sm font-semibold border transition-colors ${
                    linkCopied
                      ? 'bg-green-50 border-green-300 text-green-700'
                      : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {linkCopied ? '✓ Copied' : 'Copy'}
                </button>
              </div>
              <p className="text-xs text-gray-400">
                Questions are cached per role — only generated once regardless of how many candidates apply.
              </p>
            </div>
          )}

          {/* Results table */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-700">
                Screening Results
                {screeningResults.length > 0 && (
                  <span className="ml-2 bg-indigo-100 text-indigo-700 text-xs px-2 py-0.5 rounded-full">
                    {screeningResults.length}
                  </span>
                )}
              </h3>
              <button
                onClick={() => loadScreeningResults(savedJd.id)}
                disabled={loadingResults}
                className="text-xs text-gray-400 hover:text-gray-600 underline"
              >
                {loadingResults ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>

            {screeningResults.length === 0 ? (
              <div className="border border-dashed border-gray-200 rounded-xl p-8 text-center">
                <p className="text-sm text-gray-400">No completed screenings yet. Share the link above with candidates.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 text-left text-xs text-gray-400 font-semibold uppercase tracking-wide">
                      <th className="pb-2 pr-3">Candidate</th>
                      <th className="pb-2 pr-3">Score</th>
                      <th className="pb-2 pr-3">Grade</th>
                      <th className="pb-2 pr-3">Mode</th>
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
                      const modeInfo = INTERVIEW_MODES[r.interview_mode || 'text_only']
                      return (
                        <tr
                          key={r.session_id}
                          className={`hover:bg-gray-50 transition-colors ${
                            selectedSession === r.session_id ? 'bg-indigo-50' : ''
                          }`}
                        >
                          <td className="py-3 pr-3">
                            <p className="font-medium text-gray-800">{r.candidate_name}</p>
                            <p className="text-xs text-gray-400">{r.candidate_email}</p>
                          </td>
                          <td className="py-3 pr-3 font-bold text-gray-800">
                            {r.overall_score ?? '—'}/100
                          </td>
                          <td className="py-3 pr-3">
                            <span className={`inline-block text-xs font-bold px-2 py-0.5 rounded ${gradeStyle}`}>
                              {r.overall_grade ?? '—'}
                            </span>
                          </td>
                          <td className="py-3 pr-3">
                            <span className="text-xs text-gray-500 whitespace-nowrap">
                              {modeInfo?.icon} {modeInfo?.label}
                            </span>
                          </td>
                          <td className="py-3 pr-3">
                            <div className="group relative inline-flex items-center gap-1.5 cursor-default">
                              <div className={`w-2.5 h-2.5 rounded-full ${integrity.dot}`} />
                              <span className="text-xs text-gray-500">{integrity.label}</span>
                              {r.integrity_verdict && (
                                <div className="absolute bottom-full left-0 mb-1 hidden group-hover:block z-10 w-56 bg-gray-900 text-white text-xs rounded-lg px-3 py-2 shadow-lg pointer-events-none">
                                  {r.integrity_verdict}
                                </div>
                              )}
                            </div>
                          </td>
                          {/* Decision column */}
                          <td className="py-3 pr-3">
                            {r.recruiter_decision ? (
                              <span className={`inline-block text-xs font-semibold px-2.5 py-1 rounded-full ${DECISION_BADGE[r.recruiter_decision]?.color}`}>
                                {DECISION_BADGE[r.recruiter_decision]?.label}
                              </span>
                            ) : (
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={() => handleQuickDecision(r.session_id, 'advance')}
                                  title="Advance"
                                  className="w-6 h-6 rounded-full bg-green-100 hover:bg-green-200 text-green-700 flex items-center justify-center text-xs font-bold transition-colors"
                                >✓</button>
                                <button
                                  onClick={() => handleQuickDecision(r.session_id, 'reject')}
                                  title="Reject"
                                  className="w-6 h-6 rounded-full bg-red-100 hover:bg-red-200 text-red-700 flex items-center justify-center text-xs font-bold transition-colors"
                                >✗</button>
                                <button
                                  onClick={() => handleQuickDecision(r.session_id, 'hold')}
                                  title="Hold"
                                  className="w-6 h-6 rounded-full bg-amber-100 hover:bg-amber-200 text-amber-700 flex items-center justify-center text-xs font-bold transition-colors"
                                >?</button>
                              </div>
                            )}
                          </td>
                          <td className="py-3 pr-3">
                            <span className={`inline-block text-xs font-semibold px-2.5 py-1 rounded-full ${rec.color}`}>
                              {rec.label}
                            </span>
                          </td>
                          <td className="py-3 pr-3 text-xs text-gray-400">
                            {new Date(r.created_at).toLocaleDateString()}
                          </td>
                          <td className="py-3">
                            <div className="flex items-center gap-2 whitespace-nowrap">
                              <button
                                onClick={() => handleViewReport(r.session_id)}
                                className="text-xs text-indigo-600 hover:text-indigo-800 font-semibold underline"
                              >
                                Full Report
                              </button>
                              <span className="text-gray-300">|</span>
                              <button
                                onClick={() => handleViewAnswers(r.session_id)}
                                className="text-xs text-purple-600 hover:text-purple-800 font-semibold underline"
                              >
                                Review Answers
                              </button>
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

          {/* Full report panel */}
          {selectedSession && (
            <div className="border border-indigo-200 rounded-xl bg-indigo-50 p-6 space-y-5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-indigo-800">Full Screening Report</h3>
                <button
                  onClick={() => { setSelectedSession(null); setSessionDetail(null) }}
                  className="text-xs text-gray-400 hover:text-gray-600"
                >
                  ✕ Close
                </button>
              </div>

              {loadingDetail ? (
                <div className="flex items-center gap-2 text-sm text-gray-500">
                  <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  Loading report…
                </div>
              ) : sessionDetail ? (
                <div className="space-y-5">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-sm font-semibold text-gray-800">{sessionDetail.candidate_name}</p>
                      <p className="text-xs text-gray-500">{sessionDetail.candidate_email}</p>
                    </div>
                    {(() => {
                      const m = INTERVIEW_MODES[sessionDetail.interview_mode || 'text_only']
                      return m ? (
                        <span className="text-xs bg-teal-100 text-teal-700 font-semibold px-2.5 py-1 rounded-full">
                          {m.icon} {m.label}
                        </span>
                      ) : null
                    })()}
                  </div>

                  {(() => {
                    const ag = sessionDetail.integrity_agreement || {}
                    return (
                      <p className="text-xs text-gray-400">
                        {ag.agreed
                          ? `✓ Integrity agreement signed at ${new Date(ag.agreed_at).toLocaleString()} (version ${ag.version})`
                          : '⚠ Candidate did not complete the integrity agreement'}
                      </p>
                    )
                  })()}

                  {/* Decision badge if exists */}
                  {sessionDetail.recruiter_decision && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500">Decision:</span>
                      <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${DECISION_BADGE[sessionDetail.recruiter_decision]?.color}`}>
                        {DECISION_BADGE[sessionDetail.recruiter_decision]?.label}
                      </span>
                      {sessionDetail.decided_at && (
                        <span className="text-xs text-gray-400">
                          — {new Date(sessionDetail.decided_at).toLocaleDateString()}
                        </span>
                      )}
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
                            <p className={`text-xs mt-0.5 opacity-80 ${banner.text}`}>
                              {sessionDetail.report.integrity.verdict}
                            </p>
                          )}
                        </div>
                      </div>
                    )
                  })()}

                  {sessionDetail.report?.headline && (
                    <div className="bg-white rounded-lg p-3 border border-indigo-100">
                      <p className="text-xs font-semibold text-gray-400 mb-1">HEADLINE</p>
                      <p className="text-sm text-gray-700 italic">"{sessionDetail.report.headline}"</p>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-4">
                    {sessionDetail.report?.strengths?.length > 0 && (
                      <div className="bg-white rounded-lg p-3 border border-indigo-100">
                        <p className="text-xs font-semibold text-green-600 mb-2">STRENGTHS</p>
                        <ul className="space-y-1">
                          {sessionDetail.report.strengths.map((s, i) => (
                            <li key={i} className="text-xs text-gray-700 flex gap-1.5">
                              <span className="text-green-500 flex-shrink-0">✓</span>{s}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {sessionDetail.report?.concerns?.length > 0 && (
                      <div className="bg-white rounded-lg p-3 border border-indigo-100">
                        <p className="text-xs font-semibold text-amber-600 mb-2">CONCERNS</p>
                        <ul className="space-y-1">
                          {sessionDetail.report.concerns.map((c, i) => (
                            <li key={i} className="text-xs text-gray-700 flex gap-1.5">
                              <span className="text-amber-500 flex-shrink-0">⚠</span>{c}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>

                  {sessionDetail.report?.suggested_interview_topics?.length > 0 && (
                    <div className="bg-white rounded-lg p-3 border border-indigo-100">
                      <p className="text-xs font-semibold text-indigo-600 mb-2">SUGGESTED INTERVIEW TOPICS</p>
                      <div className="flex flex-wrap gap-2">
                        {sessionDetail.report.suggested_interview_topics.map((t, i) => (
                          <span key={i} className="text-xs bg-indigo-100 text-indigo-700 px-2.5 py-1 rounded-full">{t}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  {sessionDetail.report?.dimension_summary && (
                    <div className="bg-white rounded-lg p-3 border border-indigo-100">
                      <p className="text-xs font-semibold text-gray-400 mb-2">DIMENSION SUMMARY</p>
                      <div className="space-y-2">
                        {Object.entries(sessionDetail.report.dimension_summary).map(([dim, summary]) => (
                          <div key={dim}>
                            <p className="text-xs font-semibold text-gray-600 capitalize mb-0.5">{dim.replace(/_/g, ' ')}</p>
                            <p className="text-xs text-gray-500">{summary}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {(() => {
                    const mode = sessionDetail.interview_mode || 'text_only'
                    const speechAnalysis = sessionDetail.report?.speech_analysis
                    const speechMetrics = sessionDetail.report?.speech_metrics
                    if (mode === 'text_only' || (!speechAnalysis && !speechMetrics)) return null
                    return (
                      <div className="bg-white rounded-lg p-3 border border-indigo-100">
                        <p className="text-xs font-semibold text-indigo-600 mb-2">🎙 SPEECH ANALYSIS</p>
                        {speechAnalysis && <p className="text-xs text-gray-700 mb-3 italic">{speechAnalysis}</p>}
                        {speechMetrics && (
                          <div className="flex flex-wrap gap-4">
                            {speechMetrics.avg_wpm != null && (
                              <div className="text-center">
                                <p className="text-base font-bold text-gray-800">{speechMetrics.avg_wpm}</p>
                                <p className="text-xs text-gray-400">Avg WPM</p>
                              </div>
                            )}
                            {speechMetrics.total_filler_words != null && (
                              <div className="text-center">
                                <p className="text-base font-bold text-gray-800">{speechMetrics.total_filler_words}</p>
                                <p className="text-xs text-gray-400">Filler words</p>
                              </div>
                            )}
                            {speechMetrics.total_duration_seconds != null && (
                              <div className="text-center">
                                <p className="text-base font-bold text-gray-800">{Math.round(speechMetrics.total_duration_seconds)}s</p>
                                <p className="text-xs text-gray-400">Total speech</p>
                              </div>
                            )}
                            {speechMetrics.questions_with_speech != null && (
                              <div className="text-center">
                                <p className="text-base font-bold text-gray-800">{speechMetrics.questions_with_speech}</p>
                                <p className="text-xs text-gray-400">Qs spoken</p>
                              </div>
                            )}
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
                      <div className="bg-white rounded-lg border border-indigo-100 overflow-hidden">
                        <button
                          onClick={() => setIntegrityExpanded((v) => !v)}
                          className="w-full flex items-center justify-between px-3 py-2.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 transition-colors"
                        >
                          <span>
                            🛡 Integrity Details
                            <span className="ml-1.5 bg-indigo-100 px-1.5 py-0.5 rounded-full">
                              {flagged.length} flagged answer{flagged.length !== 1 ? 's' : ''}
                            </span>
                          </span>
                          <span className="text-gray-400">{integrityExpanded ? '▲' : '▼'}</span>
                        </button>
                        {integrityExpanded && (
                          <div className="px-3 pb-3 space-y-3 border-t border-indigo-100 pt-3">
                            {flagged.map((q) => {
                              const riskDot = INTEGRITY_DOT[q.integrity_risk] || INTEGRITY_DOT.none
                              return (
                                <div key={q.question_index}>
                                  <div className="flex items-center gap-2 mb-1.5">
                                    <div className={`w-2 h-2 rounded-full ${riskDot.dot}`} />
                                    <p className="text-xs font-semibold text-gray-700">Question {q.question_index + 1}</p>
                                    <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                                      q.integrity_risk === 'suspicious' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                                    }`}>{riskDot.label}</span>
                                  </div>
                                  <div className="space-y-1.5 pl-4">
                                    {q.flags.map((flag, fi) => <FlagBadge key={fi} flag={flag} />)}
                                  </div>
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
        </section>
      )}
    </div>
  )
}
