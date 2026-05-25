import { useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../lib/auth'

const FEATURES = [
  {
    icon: '🤖',
    title: 'AI Screening',
    desc: 'Automated multi-turn interviews powered by Claude Haiku — consistent, unbiased, and available 24/7.',
  },
  {
    icon: '📊',
    title: 'Deep Insights',
    desc: 'Rich scorecards covering relevance, communication, and role fit — with speech metrics and follow-up analysis.',
  },
  {
    icon: '🔒',
    title: 'Integrity Monitoring',
    desc: 'Tab-switch detection, paste tracking, and response-timing analysis keep every screening honest.',
  },
]

export default function Home() {
  const { user, role, isLoading } = useAuthStore()
  const navigate = useNavigate()

  // Redirect already-authenticated users straight to their dashboard
  useEffect(() => {
    if (!isLoading && user) {
      navigate(role === 'recruiter' ? '/dashboard' : '/candidate', { replace: true })
    }
  }, [user, role, isLoading, navigate])

  // Don't flash the landing page while session is being restored
  if (isLoading) return null

  return (
    <div className="min-h-[calc(100vh-64px)] bg-gradient-to-br from-teal-50 via-white to-indigo-50">
      {/* ── Hero ── */}
      <div className="max-w-4xl mx-auto px-6 pt-20 pb-16 text-center">
        <div className="inline-flex items-center gap-2 bg-teal-100 text-teal-700 text-xs font-semibold px-3 py-1.5 rounded-full mb-6">
          ✨ Powered by Claude Haiku
        </div>

        <h1 className="text-5xl font-extrabold text-gray-900 leading-tight mb-4">
          AI-Powered Recruitment
        </h1>
        <p className="text-xl text-gray-500 mb-10">
          Screen smarter. Hire better.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link
            to="/login"
            state={{ tab: 'signup' }}
            className="bg-teal-600 hover:bg-teal-700 text-white font-semibold px-8 py-3 rounded-xl text-sm transition-colors shadow-lg shadow-teal-200"
          >
            Get started free
          </Link>
          <Link
            to="/login"
            className="text-teal-600 hover:text-teal-700 font-semibold text-sm transition-colors"
          >
            Already have an account? Log in →
          </Link>
        </div>
      </div>

      {/* ── Feature cards ── */}
      <div className="max-w-4xl mx-auto px-6 pb-20">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 hover:shadow-md transition-shadow"
            >
              <div className="text-3xl mb-3">{f.icon}</div>
              <h3 className="text-base font-semibold text-gray-900 mb-2">{f.title}</h3>
              <p className="text-sm text-gray-500 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── Footer strip ── */}
      <div className="border-t border-gray-100 bg-white/60 backdrop-blur-sm py-6">
        <p className="text-center text-xs text-gray-400">
          © {new Date().getFullYear()} RecruitAI · Built with{' '}
          <span className="text-teal-500 font-medium">Anthropic Claude</span>
        </p>
      </div>
    </div>
  )
}
