import { useState } from 'react'
import ScoreRadar from './ScoreRadar'

const RECOMMENDATION_STYLES = {
  // New-style keys from Claude
  strong_match:  { label: 'Strong Match',  cls: 'bg-green-50 text-green-700 border border-green-200' },
  good_match:    { label: 'Good Match',    cls: 'bg-blue-50 text-blue-700 border border-blue-200' },
  partial_match: { label: 'Partial Match', cls: 'bg-amber-50 text-amber-700 border border-amber-200' },
  weak_match:    { label: 'Weak Match',    cls: 'bg-red-50 text-red-600 border border-red-200' },
  // Old-style keys (backwards compat with cached scores)
  strong_yes:    { label: 'Strong Match',  cls: 'bg-green-50 text-green-700 border border-green-200' },
  yes:           { label: 'Good Match',    cls: 'bg-blue-50 text-blue-700 border border-blue-200' },
  maybe:         { label: 'Partial Match', cls: 'bg-amber-50 text-amber-700 border border-amber-200' },
  no:            { label: 'Weak Match',    cls: 'bg-red-50 text-red-600 border border-red-200' },
}

const DIMENSIONS = [
  { key: 'hard_skills_match',   label: 'Hard Skills Match' },
  { key: 'experience_fit',      label: 'Experience Fit' },
  { key: 'education_alignment', label: 'Education Alignment' },
  { key: 'soft_skills_signals', label: 'Soft Skills' },
  { key: 'industry_relevance',  label: 'Industry Fit' },
  { key: 'career_trajectory',   label: 'Career Trajectory' },
]

const DIM_SHORT = {
  hard_skills_match:   'Hard Skills',
  experience_fit:      'Experience',
  education_alignment: 'Education',
  soft_skills_signals: 'Soft Skills',
  industry_relevance:  'Industry Fit',
  career_trajectory:   'Trajectory',
}

export default function CandidateScoreCard({
  candidate,
  rank,
  onViewResume,
  onInvite,
  isInvited,
  weightsUsed,
}) {
  const [expanded, setExpanded]   = useState(false)
  const [copied, setCopied]       = useState(false)

  const { score_json, total_score, recommendation } = candidate
  const recStyle = RECOMMENDATION_STYLES[recommendation] || RECOMMENDATION_STYLES.weak_match

  // Pull matched / gap skills from hard_skills_match for the Profile Signals card
  const matchedSkills = (score_json?.hard_skills_match?.matched || []).slice(0, 4)
  const gapSkills     = (score_json?.hard_skills_match?.gaps    || []).slice(0, 4)

  const handleCopyOutreach = () => {
    const text = score_json?.outreach_draft || ''
    if (!text) return
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-5 mb-4 shadow-sm">

      {/* ── Card header ─────────────────────────────────────────────── */}
      <div className="flex items-start gap-4">

        {/* Rank circle */}
        <div className="w-10 h-10 rounded-full bg-teal-600 text-white flex items-center justify-center text-sm font-bold flex-shrink-0 mt-0.5">
          #{rank}
        </div>

        {/* Name + controls */}
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <h3 className="text-base font-bold text-gray-900">{candidate.candidate_name}</h3>

            <span className={`text-xs font-medium px-2.5 py-0.5 rounded-full ${recStyle.cls}`}>
              {recStyle.label}
            </span>

            {onViewResume && (
              <button
                onClick={onViewResume}
                className="text-gray-500 hover:text-gray-700 text-xs flex items-center gap-1 underline transition-colors"
              >
                📄 View Resume
              </button>
            )}

            {isInvited ? (
              <button
                disabled
                className="bg-gray-100 text-gray-400 text-xs font-medium px-3 py-1.5 rounded-lg cursor-default"
              >
                Invited ✓
              </button>
            ) : onInvite ? (
              <button
                onClick={onInvite}
                className="bg-teal-600 hover:bg-teal-700 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
              >
                Prepare Virtual Interview
              </button>
            ) : null}

          </div>

          <p className="text-xs text-gray-400 mb-2">{candidate.candidate_email}</p>
          <p className="text-sm text-gray-600 leading-relaxed">{score_json?.overall_summary}</p>
        </div>

        {/* Score + weight tooltip */}
        <div className="text-right flex-shrink-0 ml-2">
          <div className="flex items-start justify-end gap-1">
            <div className="text-3xl font-bold text-amber-500">{total_score}</div>
            {weightsUsed && (
              <div className="relative group mt-1">
                <span className="text-gray-400 text-xs cursor-help select-none">ⓘ</span>
                <div className="absolute right-0 bottom-6 w-72 bg-gray-800 text-white text-xs rounded-lg p-2.5 hidden group-hover:block z-20 leading-relaxed shadow-xl">
                  <p className="font-semibold mb-1 text-gray-200">Scoring weights for this role:</p>
                  {Object.entries(weightsUsed)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, v]) => (
                      <span key={k} className="inline-block mr-2">
                        {DIM_SHORT[k] || k} <span className="text-teal-300">{Math.round(v * 100)}%</span>
                      </span>
                    ))
                  }
                </div>
              </div>
            )}
          </div>
          <div className="text-xs text-gray-400 mt-0.5">/ 100</div>
        </div>
      </div>

      {/* ── Show / hide toggle ───────────────────────────────────────── */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="text-teal-600 text-sm font-medium cursor-pointer hover:text-teal-700 mt-3 inline-flex items-center gap-1 transition-colors"
      >
        {expanded ? 'Hide breakdown ▲' : 'Show breakdown ▼'}
      </button>

      {/* ── Breakdown ────────────────────────────────────────────────── */}
      {expanded && (
        <div className="mt-4 pt-4 border-t border-gray-100 space-y-5">

          {/* Row 1 — Three insight cards (only rendered when data exists) */}
          {(score_json?.why_this_person || matchedSkills.length > 0 || gapSkills.length > 0 || score_json?.outreach_draft) && (
          <div className="flex flex-col lg:flex-row gap-4">

            {/* Card 1 — Why This Person */}
            {score_json?.why_this_person && (
            <div className="bg-white border border-gray-100 rounded-xl p-4 flex-1">
              <h4 className="text-xs font-semibold text-teal-600 uppercase tracking-wide mb-2">
                Why This Person?
              </h4>
              <p className="text-sm text-gray-700 leading-relaxed">
                {score_json.why_this_person}
              </p>
            </div>
            )}

            {/* Card 2 — Profile Signals */}
            {(matchedSkills.length > 0 || gapSkills.length > 0) && (
            <div className="bg-white border border-gray-100 rounded-xl p-4 flex-1">
              <h4 className="text-xs font-semibold text-purple-600 uppercase tracking-wide mb-3">
                Profile Signals
              </h4>

              {matchedSkills.length > 0 && (
                <div className="flex flex-wrap mb-2">
                  {matchedSkills.map((skill, i) => (
                    <span
                      key={i}
                      className="inline-block bg-gray-100 text-gray-600 text-xs px-2 py-1 rounded-full mr-1 mb-1"
                    >
                      {skill}
                    </span>
                  ))}
                </div>
              )}

              {gapSkills.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-gray-400 mb-1">Missing:</p>
                  <div className="flex flex-wrap">
                    {gapSkills.map((skill, i) => (
                      <span
                        key={i}
                        className="inline-block bg-red-50 text-red-600 text-xs px-2 py-1 rounded-full mr-1 mb-1"
                      >
                        {skill}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
            )}

            {/* Card 3 — Outreach Draft */}
            {score_json?.outreach_draft && (
            <div className="bg-white border border-gray-100 rounded-xl p-4 flex-1">
              <h4 className="text-xs font-semibold text-violet-600 uppercase tracking-wide mb-2">
                Outreach Draft
              </h4>
              <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">
                {score_json.outreach_draft}
              </p>
              <button
                onClick={handleCopyOutreach}
                className="text-xs text-gray-400 hover:text-gray-600 mt-2 flex items-center gap-1 transition-colors"
              >
                {copied ? '✓ Copied' : 'Copy message'}
              </button>
            </div>
            )}
          </div>
          )}

          {/* Row 2+3 — Score bars (left) + radar chart (right) */}
          <div className="flex flex-col lg:flex-row gap-6">

            {/* Score bars */}
            <div className="flex-1 space-y-4">
              {DIMENSIONS.map(({ key, label }) => {
                const dim   = score_json?.[key] || {}
                const score = dim.score ?? 0
                return (
                  <div key={key}>
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-sm font-bold text-gray-700">
                        {label}
                        {weightsUsed?.[key] && (
                          <span className="text-xs font-normal text-gray-400 ml-1.5">
                            · {Math.round(weightsUsed[key] * 100)}% weight
                          </span>
                        )}
                      </span>
                      <span className="text-sm font-bold text-gray-900">{score}/100</span>
                    </div>
                    <div className="w-full bg-gray-100 rounded-full h-2 mb-1">
                      <div
                        className="bg-teal-500 h-2 rounded-full transition-all duration-500"
                        style={{ width: `${score}%` }}
                      />
                    </div>
                    {dim.reason && (
                      <p className="text-xs text-gray-500 italic mb-1">{dim.reason}</p>
                    )}
                    <div className="flex flex-wrap">
                      {(dim.matched || []).map((item, i) => (
                        <span
                          key={i}
                          className="inline-block bg-gray-100 text-gray-600 text-xs px-2 py-1 rounded-full mr-1 mb-1"
                        >
                          {item}
                        </span>
                      ))}
                      {(dim.gaps || []).map((item, i) => (
                        <span
                          key={i}
                          className="inline-block bg-red-50 text-red-600 text-xs px-2 py-1 rounded-full mr-1 mb-1"
                        >
                          {item}
                        </span>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Radar chart */}
            <div className="flex-shrink-0 flex items-start justify-center pt-2">
              <ScoreRadar scoreJson={score_json} />
            </div>
          </div>

        </div>
      )}
    </div>
  )
}
