import { useState, useEffect } from 'react'

// Module-level reference so toast() can be called from anywhere without hooks
let _toastFn = null

export const toast = {
  success: (msg) => _toastFn?.('success', msg),
  error:   (msg) => _toastFn?.('error',   msg),
  info:    (msg) => _toastFn?.('info',     msg),
}

const COLOURS = {
  success: 'bg-teal-600',
  error:   'bg-red-600',
  info:    'bg-blue-600',
}

const ICONS = {
  success: '✓',
  error:   '✕',
  info:    'ℹ',
}

export function ToastContainer() {
  const [toasts, setToasts] = useState([])

  useEffect(() => {
    _toastFn = (type, message) => {
      const id = Date.now() + Math.random()
      setToasts((prev) => [...prev, { id, type, message }])
      setTimeout(
        () => setToasts((prev) => prev.filter((t) => t.id !== id)),
        3500,
      )
    }
    return () => {
      _toastFn = null
    }
  }, [])

  if (!toasts.length) return null

  return (
    <div className="fixed bottom-5 right-5 z-[9999] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`${COLOURS[t.type]} text-white px-4 py-3 rounded-lg shadow-xl
                      text-sm font-medium flex items-center gap-2.5
                      animate-[fadeInUp_0.2s_ease-out] pointer-events-auto`}
        >
          <span className="flex-shrink-0 font-bold">{ICONS[t.type]}</span>
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  )
}
