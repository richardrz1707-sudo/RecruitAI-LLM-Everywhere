export default function ScoreBar({ label, score }) {
  const pct = Math.min(100, Math.max(0, score ?? 0))
  const barColor =
    pct >= 80 ? 'bg-green-500' : pct >= 60 ? 'bg-amber-400' : 'bg-red-500'
  const textColor =
    pct >= 80 ? 'text-green-700' : pct >= 60 ? 'text-amber-600' : 'text-red-600'

  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-gray-600 w-44 flex-shrink-0">{label}</span>
      <div className="flex-1 bg-gray-100 rounded-full h-2.5 overflow-hidden">
        <div
          className={`${barColor} h-2.5 rounded-full transition-all duration-700`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-sm font-semibold w-16 text-right ${textColor}`}>
        {pct} / 100
      </span>
    </div>
  )
}
