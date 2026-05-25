import { Navigate } from 'react-router-dom'
import { useAuthStore } from '../lib/auth'

export default function ProtectedRoute({ children, role }) {
  const { user, role: userRole, isLoading } = useAuthStore()

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-teal-600" />
      </div>
    )
  }

  if (!user) return <Navigate to="/login" replace />
  if (role && userRole !== role) return <Navigate to="/login" replace />

  return children
}
