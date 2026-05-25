const GRADE_STYLES = {
  A: 'bg-green-100 text-green-700 border-green-300',
  B: 'bg-teal-100 text-teal-700 border-teal-300',
  C: 'bg-amber-100 text-amber-700 border-amber-300',
  D: 'bg-red-100 text-red-700 border-red-300',
  F: 'bg-red-100 text-red-700 border-red-300',
}

export default function GradeBadge({ grade }) {
  const style = GRADE_STYLES[grade] || GRADE_STYLES.F
  return (
    <div
      className={`w-24 h-24 rounded-2xl border-2 flex items-center justify-center mx-auto ${style}`}
    >
      <span className="text-6xl font-bold leading-none">{grade || 'F'}</span>
    </div>
  )
}
