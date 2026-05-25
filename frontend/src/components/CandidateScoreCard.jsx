import { useState } from 'react'
import ScoreRadar from './ScoreRadar'

const RANK_COLORS = {
  1: 'bg-teal-500',
  2: 'bg-purple-500',
  3: 'bg-amber-500',
}

const RECOMMENDATION_STYLES = {
  strong_match: { label: 'Strong Match', cls: 'bg-green-100 text-green-800' },
  good_match: { label: 'Good Match', cls: 'bg-blue-100 text-blue-800' },
  partial_match: { label: 'Partial Match', cls: 'bg-amber-100 text-amber-800' },
  weak_match: { label: 'Weak Match', cls: 'bg-red-100 text-red-800' },
}

const DIMENSIONS = [
  { key: 'hard_skills_match', label: 'Hard Skills Match' },
  { key: 'experience_fit', label: 'Experience Fit' },
  { key: 'education_alignment', label: 'Education Alignment' },
  { key: 'soft_skills_signals', label: 'Soft Skills Signals' },
  { key: 'industry_relevance', label: 'Industry Relevance' },
  { key: 'career_trajectory', label: 'Career Trajectory' },
]

export default function CandidateScoreCard({ candidate, rank, onViewResume }) {
  const [expanded, setExpanded] = useState(false)

  const { score_json, total_score, recommendation } = candidate
  const recStyle =
    RECOMMENDATION_STYLES[recommendation] || RECOMMENDATION_STYLES.weak_match
  const rankBg = RANK_COLORS[rank] || 'bg-gray-400'

  const scoreColor =
    total_score >= 80
      ? 'text-green-600'
      : total_score >= 60
      ? 'text-amber-500'
      : 'text-red-500'

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
      <div className="flex items-start gap-4">
        <div
          className={`${rankBg} text-white rounded-full w-10 h-10 flex items-center justify-center font-bold text-sm flex-shrink-0 mt-1`}
        >
          #{rank}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <h3 className="text-lg font-semibold text-gray-900">
              {candidate.candidate_name}
            </h3>
            <span
              className={`text-xs font-medium px-2.5 py-1 rounded-full ${recStyle.cls}`}
            >
              {recStyle.label}
            </span>
            {onViewResume && (
              <button
                onClick={onViewResume}
                className="text-xs text-teal-600 hover:text-teal-700 font-medium underline transition-colors"
              >
                📄 View Resume
              </button>
            )}
          </div>
          <p className="text-sm text-gray-400 mb-3">{candidate.candidate_email}</p>
          <p className="text-sm text-gray-600 leading-relaxed">
            {score_json?.overall_summary}
          </p>
        </div>

        <div className="text-right flex-shrink-0">
          <div className={`text-3xl font-bold ${scoreColor}`}>{total_score}</div>
          <div className="text-xs text-gray-400">/ 100</div>
        </div>
      </div>

      <button
        onClick={() => setExpanded(!expanded)}
        className="mt-4 text-sm text-blue-600 hover:text-blue-700 font-medium transition-colors"
      >
        {expanded ? 'Hide breakdown ▲' : 'Show breakdown ▼'}
      </button>

      {expanded && (
        <div className="mt-5 grid grid-cols-1 lg:grid-cols-2 gap-6 border-t border-gray-100 pt-5">
          <div className="space-y-4">
            {DIMENSIONS.map(({ key, label }) => {
              const dim = score_json?.[key] || {}
              const score = dim.score ?? 0
              return (
                <div key={key}>
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-sm font-medium text-gray-700">{label}</span>
                    <span className="text-sm font-bold text-gray-900">{score}/100</span>
                  </div>
                  <div className="w-full bg-gray-100 rounded-full h-1.5 mb-1.5">
                    <div
                      className="bg-teal-500 h-1.5 rounded-full transition-all"
                      style={{ width: `${score}%` }}
                    />
                  </div>
                  {dim.reason && (
                    <p className="text-xs text-gray-500 mb-2 italic">{dim.reason}</p>
                  )}
                  <div className="flex flex-wrap gap-1">
                    {(dim.matched || []).map((item, i) => (
                      <span
                        key={i}
                        className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full"
                      >
                        {item}
                      </span>
                    ))}
                    {(dim.gaps || []).map((item, i) => (
                      <span
                        key={i}
                        className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full"
                      >
                        {item}
                      </span>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>

          <div className="flex items-center justify-center">
            <ScoreRadar scoreJson={score_json} />
          </div>
        </div>
      )}
    </div>
  )
}
