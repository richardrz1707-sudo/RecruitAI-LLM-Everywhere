import { useState, useRef, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../lib/auth'
import { logout } from '../lib/api'

export default function Navbar() {
  const { user, role, fullName, clearUser } = useAuthStore()
  const navigate = useNavigate()
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef = useRef(null)

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleLogout = async () => {
    setDropdownOpen(false)
    try { await logout() } catch { /* ignore */ }
    clearUser()
    navigate('/login', { replace: true })
  }

  // First character for avatar
  const avatarChar = (fullName || user?.email || '?')[0].toUpperCase()

  return (
    <nav className="bg-white border-b border-gray-200 shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        {/* Logo */}
        <Link to="/" className="text-xl font-bold text-teal-600">
          RecruitAI
        </Link>

        {/* Right side */}
        <div className="flex items-center gap-3">
          {user ? (
            <>
              {/* Dashboard link */}
              {role === 'recruiter' ? (
                <Link
                  to="/dashboard"
                  className="text-sm text-gray-600 hover:text-teal-600 font-medium transition-colors"
                >
                  Recruiter Dashboard
                </Link>
              ) : (
                <Link
                  to="/candidate"
                  className="text-sm text-gray-600 hover:text-teal-600 font-medium transition-colors"
                >
                  Candidate Dashboard
                </Link>
              )}

              {/* User dropdown */}
              <div className="relative" ref={dropdownRef}>
                <button
                  onClick={() => setDropdownOpen((o) => !o)}
                  className="flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-teal-600 transition-colors focus:outline-none"
                >
                  {/* Avatar circle */}
                  <div className="w-8 h-8 rounded-full bg-teal-100 text-teal-700 flex items-center justify-center text-xs font-bold flex-shrink-0">
                    {avatarChar}
                  </div>
                  <span className="max-w-[120px] truncate hidden sm:block">
                    {fullName || user.email}
                  </span>
                  <svg
                    className={`w-3.5 h-3.5 transition-transform flex-shrink-0 ${dropdownOpen ? 'rotate-180' : ''}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {dropdownOpen && (
                  <div className="absolute right-0 mt-2 w-48 bg-white border border-gray-100 rounded-xl shadow-lg py-1 z-50">
                    {/* Role badge */}
                    <div className="px-3 py-2 border-b border-gray-50">
                      <p className="text-xs text-gray-400 font-medium capitalize">{role}</p>
                      <p className="text-xs text-gray-600 truncate mt-0.5">{user.email}</p>
                    </div>
                    <button
                      onClick={handleLogout}
                      className="w-full text-left px-3 py-2.5 text-sm text-gray-700 hover:bg-red-50 hover:text-red-600 transition-colors"
                    >
                      Log out
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <Link
                to="/login"
                className="text-sm text-gray-600 hover:text-teal-600 font-medium transition-colors"
              >
                Log in
              </Link>
              <Link
                to="/login"
                state={{ tab: 'signup' }}
                className="bg-teal-600 hover:bg-teal-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
              >
                Sign up
              </Link>
            </>
          )}
        </div>
      </div>
    </nav>
  )
}
