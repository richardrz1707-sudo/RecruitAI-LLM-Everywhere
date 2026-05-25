const SIZES = {
  sm: 'h-4 w-4',
  md: 'h-8 w-8',
  lg: 'h-12 w-12',
}

export default function LoadingSpinner({ size = 'md', label = 'Loading…' }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-8">
      <div
        className={`animate-spin rounded-full ${SIZES[size]} border-b-2 border-teal-600`}
      />
      {label && <span className="text-sm text-gray-500">{label}</span>}
    </div>
  )
}
