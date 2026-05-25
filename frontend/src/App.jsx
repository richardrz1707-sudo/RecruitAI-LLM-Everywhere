import { BrowserRouter as Router, Routes, Route } from 'react-router-dom'
import { useEffect } from 'react'

import Navbar from './components/Navbar'
import ProtectedRoute from './components/ProtectedRoute'
import { ToastContainer } from './components/Toast'

import Home from './pages/Home'
import LoginPage from './pages/LoginPage'
import CandidateDashboard from './pages/CandidateDashboard'
import DashboardPage from './pages/DashboardPage'
import ScreeningPage from './pages/ScreeningPage'

import { useAuthStore } from './lib/auth'
import { getMe } from './lib/api'

/**
 * AppRoutes — must live *inside* <Router> so hooks like useNavigate work
 * in child components (Navbar, ProtectedRoute, etc.)
 *
 * Session persistence strategy:
 *  - Login goes through the backend, so the Supabase JS client never stores
 *    a session.  Instead we persist the token in localStorage via Zustand
 *    persist middleware.
 *  - On every page load we call GET /auth/me with the stored token to verify
 *    it is still valid and refresh the profile.  If it fails (expired / revoked)
 *    we clear the store and the ProtectedRoute redirects to /login.
 */
function AppRoutes() {
  const { token, setUser, clearUser, setLoading } = useAuthStore()

  useEffect(() => {
    if (!token) {
      setLoading(false)
      return
    }
    // Token exists in localStorage — verify it is still valid
    getMe()
      .then(({ data: profile }) => {
        setUser(
          { id: profile.user_id, email: profile.email },
          token,
          profile.role,
          profile.full_name || '',
        )
      })
      .catch(() => {
        // Token expired or revoked — force re-login
        clearUser()
      })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Routes>
      {/* ── Public: AI screening interview — no Navbar ── */}
      <Route path="/screen/:token" element={<ScreeningPage />} />

      {/* ── All other pages — with Navbar ── */}
      <Route
        path="/*"
        element={
          <div className="min-h-screen bg-gray-50">
            <Navbar />
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/login" element={<LoginPage />} />

              {/* Protected: recruiters only */}
              <Route
                path="/dashboard"
                element={
                  <ProtectedRoute role="recruiter">
                    <DashboardPage />
                  </ProtectedRoute>
                }
              />

              {/* Protected: candidates only */}
              <Route
                path="/candidate"
                element={
                  <ProtectedRoute role="candidate">
                    <CandidateDashboard />
                  </ProtectedRoute>
                }
              />
            </Routes>
          </div>
        }
      />
    </Routes>
  )
}

export default function App() {
  return (
    <Router>
      <AppRoutes />
      {/* Toast notifications — rendered above all routes, always visible */}
      <ToastContainer />
    </Router>
  )
}
