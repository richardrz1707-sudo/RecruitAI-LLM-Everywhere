import { useState } from 'react'
import { useNavigate, useLocation, Link } from 'react-router-dom'
import { login, signup } from '../lib/api'
import { useAuthStore } from '../lib/auth'
import { toast } from '../components/Toast'

function PasswordStrength({ password }) {
  const score = [
    password.length >= 8,
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length

  const bars = [
    { min: 1, colour: 'bg-red-400' },
    { min: 2, colour: 'bg-amber-400' },
    { min: 3, colour: 'bg-teal-400' },
    { min: 4, colour: 'bg-teal-600' },
  ]
  const labels = ['', 'Weak', 'Fair', 'Good', 'Strong']

  if (!password) return null
  return (
    <div className="mt-1.5 space-y-1">
      <div className="flex gap-1">
        {bars.map((b, i) => (
          <div
            key={i}
            className={`h-1 flex-1 rounded-full transition-colors ${
              score > i ? b.colour : 'bg-gray-200'
            }`}
          />
        ))}
      </div>
      <p className="text-xs text-gray-400">{labels[score]}</p>
    </div>
  )
}

export default function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const setUser = useAuthStore((s) => s.setUser)

  // Allow deep-linking to the signup tab via navigation state (e.g. Home "Get started" CTA)
  const [tab, setTab] = useState(location.state?.tab === 'signup' ? 'signup' : 'login')

  // Login form
  const [loginEmail, setLoginEmail]       = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [loginError, setLoginError]       = useState('')
  const [loggingIn, setLoggingIn]         = useState('')

  // Signup form
  const [fullName, setFullName]           = useState('')
  const [signupEmail, setSignupEmail]     = useState('')
  const [signupPassword, setSignupPassword] = useState('')
  const [role, setRole]                   = useState('')
  const [companyName, setCompanyName]     = useState('')
  const [signupError, setSignupError]     = useState('')
  const [signingUp, setSigningUp]         = useState(false)

  const handleLogin = async (e) => {
    e.preventDefault()
    if (!loginEmail.trim() || !loginPassword) return
    setLoggingIn(true)
    setLoginError('')
    try {
      const r = await login(loginEmail.trim(), loginPassword)
      const { access_token, user_id, email, role: userRole, full_name } = r.data
      setUser({ id: user_id, email }, access_token, userRole, full_name || '')
      toast.success(`Welcome back, ${full_name || email}!`)
      navigate(userRole === 'recruiter' ? '/dashboard' : '/candidate', { replace: true })
    } catch (err) {
      setLoginError(err.response?.data?.detail || 'Invalid email or password')
    } finally {
      setLoggingIn(false)
    }
  }

  const handleSignup = async (e) => {
    e.preventDefault()
    if (!fullName.trim() || !signupEmail.trim() || !signupPassword || !role) return
    if (signupPassword.length < 8) {
      setSignupError('Password must be at least 8 characters')
      return
    }
    setSigningUp(true)
    setSignupError('')
    try {
      const r = await signup(signupEmail.trim(), signupPassword, fullName.trim(), role, companyName.trim())
      const { access_token, user_id, email, role: userRole, full_name } = r.data
      if (access_token) {
        setUser({ id: user_id, email }, access_token, userRole, full_name || fullName)
        toast.success(`Account created! Welcome, ${full_name || fullName}!`)
        navigate(userRole === 'recruiter' ? '/dashboard' : '/candidate', { replace: true })
      } else {
        // Email confirmation required
        toast.info('Check your email to confirm your account, then log in.')
        setTab('login')
        setLoginEmail(signupEmail)
      }
    } catch (err) {
      setSignupError(err.response?.data?.detail || 'Signup failed. Try a different email.')
    } finally {
      setSigningUp(false)
    }
  }

  const inputCls =
    'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent transition-colors'
  const primaryBtn =
    'w-full bg-teal-600 hover:bg-teal-700 text-white font-medium px-4 py-2.5 rounded-lg text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2'

  return (
    <div className="min-h-screen bg-gradient-to-br from-teal-50 via-white to-indigo-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <Link to="/" className="text-2xl font-bold text-teal-600">RecruitAI</Link>
          <p className="text-sm text-gray-500 mt-1">AI-powered recruitment platform</p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
          {/* Tabs */}
          <div className="flex border-b border-gray-100">
            {['login', 'signup'].map((t) => (
              <button
                key={t}
                onClick={() => { setTab(t); setLoginError(''); setSignupError('') }}
                className={`flex-1 py-3.5 text-sm font-semibold transition-colors ${
                  tab === t
                    ? 'text-teal-600 border-b-2 border-teal-600 bg-teal-50/50'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {t === 'login' ? 'Log in' : 'Sign up'}
              </button>
            ))}
          </div>

          <div className="p-6">
            {/* ── Login ── */}
            {tab === 'login' && (
              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                  <input
                    type="email"
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                    placeholder="you@example.com"
                    autoComplete="email"
                    required
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
                  <input
                    type="password"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    placeholder="••••••••"
                    autoComplete="current-password"
                    required
                    className={inputCls}
                  />
                </div>

                {loginError && (
                  <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                    {loginError}
                  </p>
                )}

                <button type="submit" disabled={!!loggingIn} className={primaryBtn}>
                  {loggingIn ? (
                    <>
                      <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                      </svg>
                      Logging in…
                    </>
                  ) : 'Log in'}
                </button>

                <p className="text-center text-xs text-gray-400">
                  <button
                    type="button"
                    onClick={() => toast.info('Contact your admin to reset your password.')}
                    className="hover:text-gray-600 underline transition-colors"
                  >
                    Forgot password?
                  </button>
                </p>
              </form>
            )}

            {/* ── Signup ── */}
            {tab === 'signup' && (
              <form onSubmit={handleSignup} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Full Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Jane Smith"
                    required
                    className={inputCls}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Email <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="email"
                    value={signupEmail}
                    onChange={(e) => setSignupEmail(e.target.value)}
                    placeholder="you@example.com"
                    autoComplete="email"
                    required
                    className={inputCls}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Password <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="password"
                    value={signupPassword}
                    onChange={(e) => setSignupPassword(e.target.value)}
                    placeholder="Min. 8 characters"
                    autoComplete="new-password"
                    required
                    className={inputCls}
                  />
                  <PasswordStrength password={signupPassword} />
                </div>

                {/* Role selector */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    I am… <span className="text-red-500">*</span>
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { value: 'recruiter', icon: '🏢', title: "I'm a Recruiter", sub: 'Screen & hire candidates' },
                      { value: 'candidate', icon: '👤', title: "I'm a Candidate", sub: 'Apply & get screened' },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setRole(opt.value)}
                        className={`p-3 rounded-xl border-2 text-left transition-all duration-200 ${
                          role === opt.value
                            ? 'border-teal-500 bg-teal-50'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <div className="text-xl mb-1">{opt.icon}</div>
                        <div className="text-xs font-semibold text-gray-800">{opt.title}</div>
                        <div className="text-xs text-gray-500 mt-0.5 leading-snug">{opt.sub}</div>
                      </button>
                    ))}
                  </div>
                </div>

                {role === 'recruiter' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Company Name{' '}
                      <span className="text-gray-400 font-normal">(optional)</span>
                    </label>
                    <input
                      type="text"
                      value={companyName}
                      onChange={(e) => setCompanyName(e.target.value)}
                      placeholder="Acme Corp"
                      className={inputCls}
                    />
                  </div>
                )}

                {signupError && (
                  <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                    {signupError}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={signingUp || !fullName.trim() || !signupEmail.trim() || !signupPassword || !role}
                  className={primaryBtn}
                >
                  {signingUp ? (
                    <>
                      <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                      </svg>
                      Creating account…
                    </>
                  ) : 'Create Account'}
                </button>
              </form>
            )}
          </div>
        </div>

        <p className="text-center text-xs text-gray-400 mt-6">
          By signing up you agree to our{' '}
          <span className="underline cursor-pointer hover:text-gray-600">Terms of Service</span>
        </p>
      </div>
    </div>
  )
}
