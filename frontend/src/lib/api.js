import axios from 'axios'
import { useAuthStore } from './auth'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:8000/api/v1',
  withCredentials: true,
})

// Attach Bearer token from auth store to every request
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// Redirect to /login on 401
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      useAuthStore.getState().clearUser()
      window.location.href = '/login'
    }
    return Promise.reject(error)
  },
)

// ── Auth ──────────────────────────────────────────────────────────────────

export const login = (email, password) =>
  api.post('/auth/login', { email, password })

export const signup = (email, password, fullName, role, companyName = '') =>
  api.post('/auth/signup', {
    email,
    password,
    full_name: fullName,
    role,
    company_name: companyName,
  })

export const logout = () => api.post('/auth/logout')

/** Fetch own profile using the stored Bearer token — used on page refresh */
export const getMe = () => api.get('/auth/me')

// ── Candidates ────────────────────────────────────────────────────────────

export const uploadResume = (formData) =>
  api.post('/candidates/upload-resume', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })

export const getAllCandidates = () => api.get('/candidates/')

/** Public endpoint — all active JDs, for candidate resume analyser */
export const getPublicJDList = () => api.get('/candidates/jd-list')

// ── Hiring manager — JD management ───────────────────────────────────────

export const createJD = (data) => api.post('/hiring-manager/create-jd', data)

/** Auth-required — returns recruiter's own JDs with screening_count */
export const getJDPosts = (status = 'active') =>
  api.get(`/hiring-manager/jd-posts?status=${status}`)

export const updateJD = (jdId, data) =>
  api.patch(`/hiring-manager/jd/${jdId}`, data)

export const archiveJD = (jdId) =>
  api.delete(`/hiring-manager/jd/${jdId}`)

export const duplicateJD = (jdId) =>
  api.post(`/hiring-manager/duplicate-jd/${jdId}`)

export const parseJD = (jdId) =>
  api.post('/hiring-manager/parse-jd', { jd_id: jdId })

export const matchCandidates = (jdId, candidateIds, weights, forceRefresh = false) =>
  api.post('/hiring-manager/match-candidates', {
    jd_id: jdId,
    candidate_ids: candidateIds,
    weights,
    force_refresh: forceRefresh,
  })

export const getMatchResults = (jdId) =>
  api.get(`/hiring-manager/match-results/${jdId}`)

// ── Resume improver ───────────────────────────────────────────────────────

export const analyseResume = (candidateId, jdId, forceRefresh = false) =>
  api.post('/resume-improver/analyse', {
    candidate_id: candidateId,
    jd_id: jdId,
    force_refresh: forceRefresh,
  })

export const getAnalysisHistory = (candidateId) =>
  api.get(`/resume-improver/history/${candidateId}`)

// ── Phase 4: AI Screening ─────────────────────────────────────────────────

export const createScreeningLink = (jdId) =>
  api.post('/screening/create-link', { jd_id: jdId })

export const getScreeningLink = (jdId) =>
  api.get(`/screening/link/${jdId}`)

/** Candidate history by email — no auth required, survives logout */
export const getSessionsByEmail = (email) =>
  api.get(`/screening/sessions/by-email/${encodeURIComponent(email)}`)

export const getScreeningResults = (jdId) =>
  api.get(`/screening/results/${jdId}`)

export const getScreeningSessionDetail = (sessionId) =>
  api.get(`/screening/session-detail/${sessionId}`)

export const getSessionFeedback = (sessionId) =>
  api.get(`/feedback/session/${sessionId}`)

export const getMyFeedbackHistory = () =>
  api.get('/feedback/my-history')

export const getFeedbackHistoryByEmail = (email) =>
  api.get(`/feedback/history/by-email/${encodeURIComponent(email)}`)

export const startScreening = (token) =>
  api.get(`/screening/start/${token}`)

export const registerCandidate = (data) =>
  api.post('/screening/register', data)

export const submitScreeningAnswer = (
  sessionId,
  questionId,
  answer,
  isFollowup = false,
  integritySignals = null,
  speechMetrics = null,
) =>
  api.post('/screening/answer', {
    session_id: sessionId,
    question_id: questionId,
    answer,
    is_followup: isFollowup,
    integrity_signals: integritySignals,
    speech_metrics: speechMetrics,
  })

export const saveSessionDecision = (sessionId, decision, reason = '') =>
  api.patch('/screening/session-decision', {
    session_id: sessionId,
    decision,
    reason,
  })

// ── Invites ───────────────────────────────────────────────────────────────

export const createInvite = (candidateId, jdId) =>
  api.post('/invites/create', { candidate_id: candidateId, jd_id: jdId })

export const getInvitesForJd = (jdId) =>
  api.get(`/invites/for-jd/${jdId}`)

export const expireInvite = (inviteId) =>
  api.patch(`/invites/expire/${inviteId}`)

// ── Applications ──────────────────────────────────────────────────────────

export const getApplicationsForJd = (jdId) =>
  api.get(`/applications/for-jd/${jdId}`)

export const updateApplicationStatus = (applicationId, status) =>
  api.patch('/applications/status', { application_id: applicationId, status })

// ── Recruiter candidate pool ──────────────────────────────────────────────

export const getRecruiterCandidatePool = () =>
  api.get('/hiring-manager/candidates/pool')

export const getCandidateResume = (candidateId) =>
  api.get(`/hiring-manager/candidates/${candidateId}/resume`)

export const addCandidateManually = (formData) =>
  api.post('/hiring-manager/candidates/add', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })

// ── Candidate self-service (Prompt C) ────────────────────────────────────

export const getCandidateProfile = () =>
  api.get('/candidates/profile')

export const uploadMyResume = (formData) =>
  api.post('/candidates/profile/resume', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })

/** Parse a resume file without saving it to profile — returns { resume_text, filename } */
export const parseResumeOnly = (formData) =>
  api.post('/candidates/parse-resume', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })

/** Candidate's resume upload history */
export const getResumeUploadHistory = () =>
  api.get('/candidates/upload-history')

export const getJdPool = () =>
  api.get('/candidates/jd-pool')

export const applyToJd = (jdId, coverNote = '', resumeText = '') =>
  api.post('/candidates/apply', { jd_id: jdId, cover_note: coverNote, resume_text: resumeText })

export const getMyApplications = () =>
  api.get('/candidates/my-applications')

export const getMyInvites = () =>
  api.get('/candidates/my-invites')

export const refreshMyInviteToken = (inviteId) =>
  api.post(`/candidates/my-invites/${inviteId}/refresh-token`)

// ── JD visibility ─────────────────────────────────────────────────────────

export const updateJdVisibility = (jdId, visibility) =>
  api.patch('/hiring-manager/jd/visibility', { jd_id: jdId, visibility })

export default api
