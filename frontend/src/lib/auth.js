import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const useAuthStore = create(
  persist(
    (set) => ({
      user: null,
      token: null,
      role: null,
      fullName: '',
      isLoading: true,

      setUser: (user, token, role, fullName = '') =>
        set({ user, token, role, fullName, isLoading: false }),

      clearUser: () =>
        set({ user: null, token: null, role: null, fullName: '', isLoading: false }),

      setLoading: (isLoading) => set({ isLoading }),
    }),
    {
      name: 'auth-storage',
      // Only persist the auth data, never the loading flag
      partialize: (state) => ({
        user: state.user,
        token: state.token,
        role: state.role,
        fullName: state.fullName,
      }),
    },
  ),
)
