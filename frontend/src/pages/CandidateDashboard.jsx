import { useState, useEffect, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getCandidateProfile, uploadMyResume, getJdPool, applyToJd,
  getMyApplications, getMyInvites, refreshMyInviteToken, parseResumeOnly, getResumeUploadHistory,
  getPublicJDList, analyseResume, getAnalysisHistory, getSessionsByEmail,
  getMyFeedbackHistory, getFeedbackHistoryByEmail,
} from '../lib/api'
import { useAuthStore } from '../lib/auth'
import { toast } from '../components/Toast'
import LoadingSpinner from '../components/LoadingSpinner'
import GradeBadge from '../components/GradeBadge'
import ScoreBar from '../components/ScoreBar'
import CandidateChatAgent from '../components/CandidateChatAgent'

// ── Constants ─────────────────────────────────────────────────────────────

const SCORE_LABELS = {
  jd_match: 'Job description match',
  ats_score: 'ATS compatibility',
  impact_score: 'Impact & numbers',
  language_score: 'Language strength',
  structure_score: 'Resume structure',
}

const FEEDBACK_DIMENSION_LABELS = {
  english_proficiency: 'English proficiency',
  answer_quality: 'Answer quality',
  soft_skills: 'Soft skills',
  job_fit: 'Job fit',
}

const NAV_ITEMS = [
  { id: 'invites',      label: 'My Invites',       icon: '🔔' },
  { id: 'browse',       label: 'Browse Jobs',       icon: '🌐' },
  { id: 'applications', label: 'My Applications',  icon: '📋' },
  { id: 'profile',      label: 'My Profile',        icon: '👤' },
  { id: 'feedback',     label: 'My Feedback',       icon: 'F' },
  { id: 'analyse',      label: 'Analyse Resume',    icon: '🔍' },
  { id: 'history',      label: 'Analysis History',  icon: '📊' },
  { id: 'screening',    label: 'Screening History', icon: '🎙️' },
]

const STATUS_BADGE = {
  applied:     'bg-gray-100 text-gray-600',
  shortlisted: 'bg-blue-100 text-blue-700',
  invited:     'bg-teal-100 text-teal-700',
  rejected:    'bg-red-100 text-red-700',
}

const STATUS_LABEL = {
  applied:     'Applied',
  shortlisted: 'Shortlisted',
  invited:     'Invited to screen',
  rejected:    'Not selected',
}

const INVITE_BADGE = {
  pending:   'bg-amber-100 text-amber-700',
  started:   'bg-blue-100 text-blue-700',
  completed: 'bg-teal-100 text-teal-700',
  expired:   'bg-gray-100 text-gray-500',
}

// ── Main Component ────────────────────────────────────────────────────────

export default function CandidateDashboard() {
  const navigate = useNavigate()
  const { user, fullName } = useAuthStore()

  const [activeTab, setActiveTab] = useState('invites')

  // ── Profile + resume ────────────────────────────────────────────────────
  const [profile, setProfile]           = useState(null)   // { profile, candidate }
  const [loadingProfile, setLoadingProfile] = useState(true)
  const [resumeFile, setResumeFile]     = useState(null)
  const [uploadingResume, setUploadingResume] = useState(false)
  const [resumeUploads, setResumeUploads] = useState([])

  // Per-application resume (apply modal)
  const [applyResumeFile, setApplyResumeFile] = useState(null)
  const [parsingApplyResume, setParsingApplyResume] = useState(false)
  const [applyResumeText, setApplyResumeText]  = useState('')
  const [applyResumeName, setApplyResumeName]  = useState('')

  // ── Invites ─────────────────────────────────────────────────────────────
  const [invites, setInvites]           = useState([])
  const [loadingInvites, setLoadingInvites] = useState(true)
  const refreshedRef = useRef(new Set())  // prevents double-refresh per invite

  // ── Browse Jobs ──────────────────────────────────────────────────────────
  const [jdPool, setJdPool]             = useState([])
  const [loadingPool, setLoadingPool]   = useState(true)
  const [jobSearch, setJobSearch]       = useState('')
  const [applyModal, setApplyModal]     = useState(null)   // jd object | null
  const [coverNote, setCoverNote]       = useState('')
  const [applying, setApplying]         = useState(false)
  const [applyResult, setApplyResult]   = useState(null)   // { match_score, message } | null

  // ── Applications ─────────────────────────────────────────────────────────
  const [myApplications, setMyApplications] = useState([])
  const [loadingApps, setLoadingApps]   = useState(true)

  // ── Analyse (existing feature) ──────────────────────────────────────────
  const [jdPosts, setJdPosts]           = useState([])
  const [selectedJd, setSelectedJd]     = useState('')
  const [analysing, setAnalysing]       = useState(false)
  const [result, setResult]             = useState(null)
  const [analysisError, setAnalysisError] = useState('')

  // ── Resume history (existing feature) ───────────────────────────────────
  const [history, setHistory]           = useState([])

  // ── Screening history (existing feature) ────────────────────────────────
  const [pastSessions, setPastSessions]         = useState([])
  const [historyLoading, setHistoryLoading]     = useState(false)
  const [historyEmail, setHistoryEmail]         = useState('')
  const [historyEmailInput, setHistoryEmailInput] = useState('')

  // ── Candidate feedback ─────────────────────────────────────────────────
  const [feedbackHistory, setFeedbackHistory] = useState([])
  const [feedbackLoading, setFeedbackLoading] = useState(false)
  const [feedbackError, setFeedbackError] = useState('')
  const [feedbackEmailInput, setFeedbackEmailInput] = useState('')
  const [completedScreeningsFound, setCompletedScreeningsFound] = useState(null)

  // ── Load on mount ────────────────────────────────────────────────────────
  useEffect(() => {
    loadProfile()
    loadJdPool()
    loadApplications()
    getPublicJDList()
      .then((r) => setJdPosts(r.data?.data?.jd_posts || []))
      .catch(() => {})

    const savedEmail = localStorage.getItem('recruitai_candidate_email')
    if (savedEmail) {
      setFeedbackEmailInput(savedEmail)
      loadFeedbackHistory(savedEmail)
      setHistoryEmail(savedEmail)
      setHistoryEmailInput(savedEmail)
      loadScreeningHistory(savedEmail)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load invites whenever the authenticated user is known ─────────────────
  // Kept separate so a late-resolving auth token triggers a fresh fetch.
  useEffect(() => {
    if (user) {
      loadInvites()
    }
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Data loaders ─────────────────────────────────────────────────────────
  const loadProfile = async () => {
    setLoadingProfile(true)
    try {
      const r = await getCandidateProfile()
      setProfile(r.data)
      if (r.data?.candidate?.id) {
        getAnalysisHistory(r.data.candidate.id)
          .then((h) => setHistory(h.data?.data?.history || []))
          .catch(() => {})
      }
      // Load resume upload history
      getResumeUploadHistory()
        .then((h) => setResumeUploads(h.data?.uploads || []))
        .catch(() => {})
    } catch {
      setProfile(null)
    } finally {
      setLoadingProfile(false)
    }
  }

  const loadInvites = async () => {
    setLoadingInvites(true)
    try {
      const r = await getMyInvites()
      console.log('[CandidateDashboard] Invites response:', r.data)
      setInvites(r.data?.invites || [])
    } catch (err) {
      console.error('[CandidateDashboard] Failed to fetch invites:', err)
      setInvites([])
    } finally {
      setLoadingInvites(false)
    }
  }

  const loadJdPool = async () => {
    setLoadingPool(true)
    try {
      const r = await getJdPool()
      setJdPool(r.data?.jds || [])
    } catch {
      setJdPool([])
    } finally {
      setLoadingPool(false)
    }
  }

  const loadApplications = async () => {
    setLoadingApps(true)
    try {
      const r = await getMyApplications()
      setMyApplications(r.data?.applications || [])
    } catch {
      setMyApplications([])
    } finally {
      setLoadingApps(false)
    }
  }

  const loadFeedbackHistory = async (screeningEmail = '') => {
    setFeedbackLoading(true)
    setFeedbackError('')
    try {
      const email = (screeningEmail || localStorage.getItem('recruitai_candidate_email') || '').toLowerCase().trim()
      let combined = []
      let completedFound = null
      if (email) {
        const byEmail = await getFeedbackHistoryByEmail(email)
        combined = byEmail.data?.feedback_history || []
        completedFound = byEmail.data?.completed_screenings_found ?? completedFound
      } else {
        const r = await getMyFeedbackHistory()
        combined = r.data?.feedback_history || []
        completedFound = r.data?.completed_screenings_found ?? null
      }
      const seen = new Set()
      setFeedbackHistory(combined.filter((item) => {
        const key = item.session_id || item.id
        if (seen.has(key)) return false
        seen.add(key)
        return true
      }))
      setCompletedScreeningsFound(completedFound)
    } catch (err) {
      setFeedbackHistory([])
      setCompletedScreeningsFound(null)
      setFeedbackError(err.response?.data?.detail || 'Failed to load interview feedback')
    } finally {
      setFeedbackLoading(false)
    }
  }

  const loadScreeningHistory = async (email) => {
    if (!email) return
    setHistoryLoading(true)
    try {
      const res = await getSessionsByEmail(email)
      setPastSessions(res.data?.sessions || [])
    } catch {
      setPastSessions([])
    } finally {
      setHistoryLoading(false)
    }
  }

  // ── Handlers ─────────────────────────────────────────────────────────────
  const handleUploadResume = async (e) => {
    e.preventDefault()
    if (!resumeFile) return
    setUploadingResume(true)
    try {
      const fd = new FormData()
      fd.append('resume', resumeFile)
      await uploadMyResume(fd)
      toast.success('Resume uploaded!')
      setResumeFile(null)
      await loadProfile()   // re-fetches profile + upload history
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Upload failed')
    } finally {
      setUploadingResume(false)
    }
  }

  const handleParseApplyResume = async (file) => {
    if (!file) { setApplyResumeText(''); setApplyResumeName(''); return }
    setParsingApplyResume(true)
    try {
      const fd = new FormData()
      fd.append('resume', file)
      const r = await parseResumeOnly(fd)
      setApplyResumeText(r.data?.resume_text || '')
      setApplyResumeName(file.name)
    } catch {
      toast.error('Failed to parse resume — profile resume will be used instead')
      setApplyResumeText('')
      setApplyResumeName('')
    } finally {
      setParsingApplyResume(false)
    }
  }

  const resetApplyModal = () => {
    setApplyModal(null)
    setApplyResult(null)
    setCoverNote('')
    setApplyResumeFile(null)
    setApplyResumeText('')
    setApplyResumeName('')
  }

  const handleApply = async () => {
    if (!applyModal) return
    setApplying(true)
    setApplyResult(null)
    try {
      const r = await applyToJd(applyModal.id, coverNote, applyResumeText, applyResumeName)
      setApplyResult(r.data)
      toast.success(
        r.data.message === 'Already applied'
          ? 'You already applied to this role.'
          : 'Application submitted!'
      )
      await loadApplications()
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to submit application')
    } finally {
      setApplying(false)
    }
  }

  const handleAnalyse = async (forceRefresh = false) => {
    if (!candidate || !selectedJd) return
    setAnalysing(true)
    setAnalysisError('')
    setResult(null)
    try {
      const r = await analyseResume(candidate.id, selectedJd, forceRefresh)
      setResult(r.data)
      getAnalysisHistory(candidate.id)
        .then((h) => setHistory(h.data?.data?.history || []))
        .catch(() => {})
    } catch (err) {
      setAnalysisError(err.response?.data?.detail || 'Analysis failed. Please try again.')
    } finally {
      setAnalysing(false)
    }
  }

  const handleLookup = async () => {
    const email = historyEmailInput.toLowerCase().trim()
    if (!email) return
    localStorage.setItem('recruitai_candidate_email', email)
    setHistoryEmail(email)
    await Promise.all([loadScreeningHistory(email), loadFeedbackHistory(email)])
  }

  const handleFeedbackLookup = async () => {
    const email = feedbackEmailInput.toLowerCase().trim()
    if (!email) return
    localStorage.setItem('recruitai_candidate_email', email)
    setHistoryEmail(email)
    setHistoryEmailInput(email)
    await loadFeedbackHistory(email)
  }

  const handleClearHistory = () => {
    localStorage.removeItem('recruitai_candidate_email')
    setHistoryEmail('')
    setHistoryEmailInput('')
    setFeedbackEmailInput('')
    setPastSessions([])
  }

  const handleStartInvite = async (invite) => {
    // Guard: only refresh each invite once per page load
    if (refreshedRef.current.has(invite.id)) {
      navigate(`/screen/${invite.token}`)
      return
    }
    refreshedRef.current.add(invite.id)

    try {
      const refreshed = await refreshMyInviteToken(invite.id)
      const token = refreshed.data?.token || invite.token
      navigate(`/screen/${token}`)
    } catch (err) {
      // On error navigate with existing token — do NOT retry
      console.error('[handleStartInvite] refresh failed:', err)
      navigate(`/screen/${invite.token}`)
    }
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const candidate      = profile?.candidate || null
  const myProfileData  = profile?.profile   || null
  const selectedJdTitle = jdPosts.find((j) => j.id === selectedJd)?.title || ''
  const canAnalyse     = !!candidate && !!selectedJd && !analysing
  const pendingInvites = invites.filter((i) => i.status === 'pending').length
  const appliedJdIds   = useMemo(() => new Set(myApplications.map((a) => a.jd_id)), [myApplications])

  const filteredJds = useMemo(() => {
    if (!jobSearch.trim()) return jdPool
    const q = jobSearch.toLowerCase()
    return jdPool.filter(
      (j) => j.title?.toLowerCase().includes(q) || j.department?.toLowerCase().includes(q)
    )
  }, [jdPool, jobSearch])

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex min-h-[calc(100vh-64px)] bg-gray-50">

      {/* ── Apply Modal ─────────────────────────────────────────────────── */}
      {applyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <div>
                <h2 className="text-base font-bold text-gray-900">Apply — {applyModal.title}</h2>
                {applyModal.company_name && (
                  <p className="text-xs text-gray-400 mt-0.5">{applyModal.company_name}</p>
                )}
              </div>
              <button
                onClick={resetApplyModal}
                className="text-gray-400 hover:text-gray-600 text-xl leading-none transition-colors"
              >✕</button>
            </div>
            <div className="p-6 space-y-4">
              {applyResult ? (
                <div className="space-y-4">
                  <div className="text-center py-4">
                    <p className="text-3xl mb-2">🎉</p>
                    <p className="text-base font-semibold text-gray-800">
                      {applyResult.message === 'Already applied' ? 'Already applied!' : 'Application submitted!'}
                    </p>
                    {applyResult.match_score != null && (
                      <div className="mt-3 inline-block bg-teal-50 border border-teal-200 rounded-xl px-6 py-3">
                        <p className="text-xs text-teal-600 font-medium mb-1">Your match score</p>
                        <p className="text-3xl font-bold text-teal-700">{Math.round(applyResult.match_score)}%</p>
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => { resetApplyModal(); setActiveTab('applications') }}
                    className="w-full bg-teal-600 hover:bg-teal-700 text-white font-medium px-4 py-2 rounded-lg text-sm transition-colors"
                  >
                    View My Applications →
                  </button>
                </div>
              ) : (
                <>
                  {!candidate && (
                    <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                      ⚠ Upload your resume in{' '}
                      <button
                        onClick={() => { setApplyModal(null); setActiveTab('profile') }}
                        className="underline font-medium"
                      >My Profile</button>{' '}before applying.
                    </div>
                  )}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Cover note <span className="text-gray-400 font-normal">(optional)</span>
                    </label>
                    <textarea
                      value={coverNote}
                      onChange={(e) => setCoverNote(e.target.value)}
                      rows={4}
                      placeholder="Briefly tell the recruiter why you're a great fit…"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 resize-y"
                    />
                  </div>
                  {/* Per-application resume */}
                  <div className="border border-gray-200 rounded-xl p-3 space-y-2 bg-gray-50">
                    <p className="text-xs font-semibold text-gray-600">
                      Use a specific resume for this application{' '}
                      <span className="font-normal text-gray-400">(optional — uses your profile resume if left blank)</span>
                    </p>
                    <input
                      type="file"
                      accept=".pdf,.docx"
                      onChange={(e) => {
                        const f = e.target.files?.[0] || null
                        setApplyResumeFile(f)
                        handleParseApplyResume(f)
                      }}
                      className="w-full text-xs text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-white file:text-teal-700 file:border file:border-teal-200 hover:file:bg-teal-50 cursor-pointer"
                    />
                    {parsingApplyResume && (
                      <p className="text-xs text-gray-400 flex items-center gap-1.5">
                        <svg className="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                        </svg>
                        Parsing resume…
                      </p>
                    )}
                    {applyResumeName && !parsingApplyResume && (
                      <p className="text-xs text-teal-700 font-medium flex items-center gap-1">
                        ✓ <span className="truncate">{applyResumeName}</span> ready
                      </p>
                    )}
                  </div>

                  <div className="flex items-center justify-end gap-3">
                    <button
                      onClick={resetApplyModal}
                      className="border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium px-4 py-2 rounded-lg text-sm transition-colors"
                    >Cancel</button>
                    <button
                      onClick={handleApply}
                      disabled={applying || !candidate || parsingApplyResume}
                      className="bg-teal-600 hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium px-5 py-2 rounded-lg text-sm transition-colors flex items-center gap-2"
                    >
                      {applying && (
                        <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                        </svg>
                      )}
                      {applying ? 'Submitting…' : 'Submit Application'}
                    </button>
                  </div>
                  <p className="text-xs text-gray-400">Match score is calculated automatically on submission.</p>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside className="w-64 shrink-0 bg-white border-r border-gray-200 flex flex-col py-6 px-3">
        <div className="mb-6 px-3">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Candidate Portal</p>
          {loadingProfile ? (
            <p className="text-xs text-gray-400">Loading…</p>
          ) : candidate ? (
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-teal-100 flex items-center justify-center text-teal-700 font-bold text-sm shrink-0">
                {candidate.name?.[0]?.toUpperCase() || '?'}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-800 truncate">{candidate.name}</p>
                <p className="text-xs text-gray-400 truncate">{candidate.email}</p>
              </div>
            </div>
          ) : (
            <p className="text-xs text-amber-600 font-medium">Set up your profile →</p>
          )}
        </div>

        <nav className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left w-full ${
                activeTab === item.id
                  ? 'bg-teal-50 text-teal-700'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
              }`}
            >
              <span className="text-base">{item.icon}</span>
              {item.label}
              {item.id === 'invites' && pendingInvites > 0 && (
                <span className="ml-auto text-xs bg-amber-100 text-amber-700 rounded-full px-1.5 py-0.5 font-semibold">{pendingInvites}</span>
              )}
              {item.id === 'applications' && myApplications.length > 0 && (
                <span className="ml-auto text-xs bg-teal-100 text-teal-700 rounded-full px-1.5 py-0.5 font-semibold">{myApplications.length}</span>
              )}
              {item.id === 'feedback' && feedbackHistory.length > 0 && (
                <span className="ml-auto text-xs bg-teal-100 text-teal-700 rounded-full px-1.5 py-0.5 font-semibold">{feedbackHistory.length}</span>
              )}
              {item.id === 'history' && history.length > 0 && (
                <span className="ml-auto text-xs bg-teal-100 text-teal-700 rounded-full px-1.5 py-0.5 font-semibold">{history.length}</span>
              )}
              {item.id === 'screening' && pastSessions.length > 0 && (
                <span className="ml-auto text-xs bg-teal-100 text-teal-700 rounded-full px-1.5 py-0.5 font-semibold">{pastSessions.length}</span>
              )}
            </button>
          ))}
        </nav>

        <div className="mt-auto px-3 pt-6">
          {candidate?.resume_url ? (
            <a
              href={candidate.resume_url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-teal-600 hover:text-teal-800 font-medium underline"
            >
              📄 View current resume ↗
            </a>
          ) : (
            <p className="text-xs text-gray-400">Upload a resume in My Profile.</p>
          )}
        </div>
      </aside>

      {/* ── Main content ─────────────────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto">

        {/* ══ MY INVITES ══ */}
        {activeTab === 'invites' && (
          <div className="max-w-3xl mx-auto px-6 py-10 space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-2xl font-bold text-gray-900">My Invites</h1>
                <p className="text-sm text-gray-500 mt-1">Recruiters who want to interview you for their roles.</p>
              </div>
              <button onClick={loadInvites} className="text-xs text-gray-400 hover:text-gray-600 underline transition-colors">
                Refresh
              </button>
            </div>

            {loadingInvites ? (
              <LoadingSpinner label="Loading invites…" />
            ) : invites.length === 0 ? (
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-12 text-center">
                <p className="text-4xl mb-3">🔔</p>
                <p className="text-gray-500 text-sm mb-2">No invites yet.</p>
                <button
                  onClick={() => setActiveTab('browse')}
                  className="text-teal-600 hover:text-teal-700 text-sm font-medium underline"
                >
                  Browse open roles and apply →
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                {invites.map((inv) => {
                  const jd = inv.jd_posts || {}
                  const company = inv.company_name || jd.company_name
                  return (
                    <div key={inv.id} className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${INVITE_BADGE[inv.status] || 'bg-gray-100 text-gray-500'}`}>
                            {inv.status.charAt(0).toUpperCase() + inv.status.slice(1)}
                          </span>
                        </div>
                        <p className="text-base font-semibold text-gray-900 truncate">{jd.title || '—'}</p>
                        {company && <p className="text-sm text-gray-500 mt-0.5">{company}</p>}
                        <div className="flex items-center gap-2 mt-1 text-xs text-gray-400 flex-wrap">
                          {jd.department && <span>{jd.department}</span>}
                          {jd.department && jd.location && <span>·</span>}
                          {jd.location && <span>{jd.location}</span>}
                          <span>·</span>
                          <span>Invited {new Date(inv.invited_at).toLocaleDateString()}</span>
                        </div>
                      </div>
                      <div className="flex-shrink-0">
                        {inv.status === 'pending' && (
                          <button
                            onClick={() => handleStartInvite(inv)}
                            className="bg-teal-600 hover:bg-teal-700 text-white font-semibold px-4 py-2 rounded-lg text-sm transition-colors whitespace-nowrap"
                          >
                            Start Screening →
                          </button>
                        )}
                        {inv.status === 'started' && (
                          <button
                            onClick={() => handleStartInvite(inv)}
                            className="bg-blue-600 hover:bg-blue-700 text-white font-semibold px-4 py-2 rounded-lg text-sm transition-colors whitespace-nowrap"
                          >
                            Continue →
                          </button>
                        )}
                        {inv.status === 'completed' && (
                          <span className="text-xs text-teal-600 font-medium">✓ Completed</span>
                        )}
                        {inv.status === 'expired' && (
                          <span className="text-xs text-gray-400">Expired</span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* ══ BROWSE JOBS ══ */}
        {activeTab === 'browse' && (
          <div className="max-w-4xl mx-auto px-6 py-10 space-y-6">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <h1 className="text-2xl font-bold text-gray-900">Browse Jobs</h1>
                <p className="text-sm text-gray-500 mt-1">Open roles you can apply to directly.</p>
              </div>
              <input
                type="text"
                value={jobSearch}
                onChange={(e) => setJobSearch(e.target.value)}
                placeholder="Search by title or department…"
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 w-64"
              />
            </div>

            {!candidate && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-700 flex items-center gap-2">
                ⚠{' '}
                <span>
                  Upload your resume in{' '}
                  <button onClick={() => setActiveTab('profile')} className="underline font-medium">My Profile</button>
                  {' '}before applying.
                </span>
              </div>
            )}

            {loadingPool ? (
              <LoadingSpinner label="Loading open roles…" />
            ) : filteredJds.length === 0 ? (
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-12 text-center">
                <p className="text-4xl mb-3">🌐</p>
                <p className="text-gray-500 text-sm">
                  {jdPool.length === 0 ? 'No open roles right now. Check back soon!' : 'No roles match your search.'}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {filteredJds.map((jd) => {
                  const alreadyApplied = appliedJdIds.has(jd.id)
                  const myApp = myApplications.find((a) => a.jd_id === jd.id)
                  return (
                    <div key={jd.id} className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex flex-col gap-3">
                      <div>
                        <p className="text-base font-semibold text-gray-900">{jd.title}</p>
                        {jd.company_name && (
                          <p className="text-sm text-gray-500 mt-0.5">{jd.company_name}</p>
                        )}
                        <div className="flex items-center gap-2 mt-1 text-xs text-gray-400 flex-wrap">
                          {jd.department && <span>{jd.department}</span>}
                          {jd.department && jd.location && <span>·</span>}
                          {jd.location && <span>{jd.location}</span>}
                        </div>
                      </div>
                      <div className="flex items-center justify-between mt-auto pt-1">
                        {alreadyApplied && myApp?.match_score != null ? (
                          <span className="text-xs bg-teal-50 text-teal-700 border border-teal-200 px-2.5 py-1 rounded-full font-semibold">
                            Match: {Math.round(myApp.match_score)}%
                          </span>
                        ) : alreadyApplied ? (
                          <span className="text-xs bg-gray-100 text-gray-500 px-2.5 py-1 rounded-full font-medium">
                            Applied
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400">Apply to see match score</span>
                        )}
                        <button
                          onClick={() => { setApplyModal(jd); setApplyResult(null); setCoverNote(''); setApplyResumeFile(null); setApplyResumeText(''); setApplyResumeName('') }}
                          className={`text-sm font-semibold px-4 py-1.5 rounded-lg transition-colors ${
                            alreadyApplied
                              ? 'border border-gray-300 text-gray-500 hover:bg-gray-50'
                              : 'bg-teal-600 hover:bg-teal-700 text-white'
                          }`}
                        >
                          {alreadyApplied ? 'Applied ✓' : 'Apply'}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* ══ MY APPLICATIONS ══ */}
        {activeTab === 'applications' && (
          <div className="max-w-3xl mx-auto px-6 py-10 space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-2xl font-bold text-gray-900">My Applications</h1>
                <p className="text-sm text-gray-500 mt-1">Track the roles you've applied to.</p>
              </div>
              <button onClick={loadApplications} className="text-xs text-gray-400 hover:text-gray-600 underline transition-colors">
                Refresh
              </button>
            </div>

            {loadingApps ? (
              <LoadingSpinner label="Loading applications…" />
            ) : myApplications.length === 0 ? (
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-12 text-center">
                <p className="text-4xl mb-3">📋</p>
                <p className="text-gray-500 text-sm mb-2">You haven't applied to any roles yet.</p>
                <button
                  onClick={() => setActiveTab('browse')}
                  className="text-teal-600 hover:text-teal-700 text-sm font-medium underline"
                >
                  Browse open roles →
                </button>
              </div>
            ) : (
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200 text-left text-xs text-gray-400 font-semibold uppercase tracking-wide">
                      <th className="px-5 py-3">Role</th>
                      <th className="px-5 py-3">Match</th>
                      <th className="px-5 py-3">Status</th>
                      <th className="px-5 py-3">Applied</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {myApplications.map((app) => {
                      const jd = app.jd_posts || {}
                      return (
                        <tr key={app.id} className="hover:bg-gray-50 transition-colors">
                          <td className="px-5 py-3">
                            <p className="font-medium text-gray-800">{jd.title || '—'}</p>
                            <div className="flex items-center gap-1 text-xs text-gray-400 flex-wrap mt-0.5">
                              {jd.department && <span>{jd.department}</span>}
                              {jd.department && jd.location && <span>·</span>}
                              {jd.location && <span>{jd.location}</span>}
                            </div>
                          </td>
                          <td className="px-5 py-3">
                            {app.match_score != null ? (
                              <span className={`text-sm font-semibold ${
                                app.match_score >= 70 ? 'text-teal-600'
                                  : app.match_score >= 50 ? 'text-amber-600'
                                  : 'text-red-500'
                              }`}>
                                {Math.round(app.match_score)}%
                              </span>
                            ) : (
                              <span className="text-gray-400">—</span>
                            )}
                          </td>
                          <td className="px-5 py-3">
                            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${STATUS_BADGE[app.status] || 'bg-gray-100 text-gray-600'}`}>
                              {STATUS_LABEL[app.status] || app.status}
                            </span>
                          </td>
                          <td className="px-5 py-3 text-xs text-gray-400">
                            {app.applied_at ? new Date(app.applied_at).toLocaleDateString() : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ══ MY PROFILE ══ */}
        {activeTab === 'profile' && (
          <div className="max-w-2xl mx-auto px-6 py-10 space-y-6">
            <h1 className="text-2xl font-bold text-gray-900">My Profile</h1>

            {loadingProfile ? (
              <LoadingSpinner label="Loading profile…" />
            ) : (
              <>
                {/* Account info */}
                <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-3">
                  <h2 className="text-sm font-semibold text-gray-700">Account Info</h2>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs text-gray-400 mb-0.5">Name</p>
                      <p className="text-sm font-medium text-gray-800">
                        {candidate?.name || myProfileData?.full_name || fullName || '—'}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-400 mb-0.5">Email</p>
                      <p className="text-sm font-medium text-gray-800">
                        {candidate?.email || myProfileData?.email || user?.email || '—'}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Resume section */}
                <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-4">
                  <h2 className="text-sm font-semibold text-gray-700">Resume</h2>

                  {(candidate?.resume_url || candidate?.resume_text || candidate?.resume_filename) ? (
                    <div className="flex items-center justify-between bg-teal-50 border border-teal-200 rounded-xl px-4 py-3">
                      <div>
                        <p className="text-sm font-medium text-teal-800">
                          📄 {candidate.resume_filename || 'Resume on file'}
                        </p>
                        {candidate.resume_url ? (
                          <a
                            href={candidate.resume_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-teal-600 hover:text-teal-800 underline"
                          >
                            View current resume ↗
                          </a>
                        ) : (
                          <p className="text-xs text-teal-500">Resume text stored (no file URL)</p>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
                      ⚠ No resume uploaded yet. Upload below to apply for roles.
                    </div>
                  )}

                  {candidate?.resume_text && (
                    <details className="text-xs text-gray-500">
                      <summary className="cursor-pointer font-medium text-gray-600 hover:text-gray-800 select-none">
                        Preview resume text ▾
                      </summary>
                      <pre className="mt-2 bg-gray-50 border border-gray-100 rounded-lg p-3 whitespace-pre-wrap font-mono text-xs leading-relaxed max-h-40 overflow-y-auto">
                        {candidate.resume_text.slice(0, 400)}{candidate.resume_text.length > 400 ? '…' : ''}
                      </pre>
                    </details>
                  )}

                  <form onSubmit={handleUploadResume} className="space-y-3">
                    <label className="block text-sm font-medium text-gray-700">
                      {candidate?.resume_url ? 'Update resume' : 'Upload resume'}{' '}
                      <span className="text-gray-400 font-normal">(PDF or DOCX)</span>
                    </label>
                    <input
                      type="file"
                      accept=".pdf,.docx"
                      onChange={(e) => setResumeFile(e.target.files?.[0] || null)}
                      className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-teal-50 file:text-teal-700 hover:file:bg-teal-100 cursor-pointer"
                    />
                    <button
                      type="submit"
                      disabled={!resumeFile || uploadingResume}
                      className="bg-teal-600 hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium px-5 py-2 rounded-lg text-sm transition-colors flex items-center gap-2"
                    >
                      {uploadingResume && (
                        <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                        </svg>
                      )}
                      {uploadingResume ? 'Uploading…' : candidate?.resume_url ? 'Update Resume' : 'Upload Resume'}
                    </button>
                  </form>
                </div>

                {/* Resume upload history */}
                {resumeUploads.length > 0 && (
                  <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-3">
                    <h2 className="text-sm font-semibold text-gray-700">Upload History</h2>
                    <div className="divide-y divide-gray-100">
                      {resumeUploads.slice(0, 8).map((u, i) => (
                        <div key={u.id} className="flex items-center justify-between py-2 gap-3">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-gray-400 text-xs font-mono w-5 text-right shrink-0">{i + 1}</span>
                            <span className="text-sm text-gray-700 truncate">
                              📄 {u.filename}
                            </span>
                          </div>
                          <div className="flex items-center gap-3 shrink-0">
                            <span className="text-xs text-gray-400">
                              {new Date(u.uploaded_at).toLocaleDateString()}
                            </span>
                            {u.resume_url && (
                              <a
                                href={u.resume_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-teal-600 hover:text-teal-800 underline"
                              >
                                View ↗
                              </a>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Resume improver shortcut */}
                <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-semibold text-gray-800">Improve your resume for a role</p>
                    <p className="text-xs text-gray-400 mt-0.5">Get AI-powered bullet rewrites and coaching tips.</p>
                  </div>
                  <button
                    onClick={() => setActiveTab('analyse')}
                    className="bg-gray-800 hover:bg-gray-900 text-white font-medium px-4 py-2 rounded-lg text-sm transition-colors whitespace-nowrap"
                  >
                    Analyse Resume →
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* ══ MY FEEDBACK ══ */}
        {activeTab === 'feedback' && (
          <div className="max-w-5xl mx-auto px-6 py-10 space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-2xl font-bold text-gray-900">My Feedback</h1>
                <p className="text-sm text-gray-500 mt-1">
                  Personalised feedback from completed AI screening interviews.
                  {historyEmail && <span> Showing screenings for {historyEmail}.</span>}
                </p>
              </div>
              <button onClick={() => loadFeedbackHistory(historyEmail)} className="text-xs text-gray-400 hover:text-gray-600 underline transition-colors">
                Refresh
              </button>
            </div>

            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Screening email
              </label>
              <div className="flex gap-2">
                <input
                  type="email"
                  placeholder="Email used during screening"
                  value={feedbackEmailInput}
                  onChange={(e) => setFeedbackEmailInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleFeedbackLookup()}
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
                <button
                  onClick={handleFeedbackLookup}
                  disabled={!feedbackEmailInput.trim() || feedbackLoading}
                  className="bg-teal-600 hover:bg-teal-700 disabled:bg-gray-300 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
                >
                  Find Feedback
                </button>
              </div>
            </div>

            {feedbackLoading ? (
              <LoadingSpinner label="Loading feedback..." />
            ) : feedbackError ? (
              <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-sm text-red-700">
                {feedbackError}
              </div>
            ) : feedbackHistory.length === 0 ? (
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-12 text-center">
                <p className="text-gray-500 text-sm">
                  {completedScreeningsFound === 0
                    ? 'No completed screenings were found for this email. Please check the exact email used during the interview.'
                    : 'No interview feedback could be loaded yet. Please restart the backend and click Find Feedback again.'}
                </p>
              </div>
            ) : (
              <div className="space-y-5">
                {feedbackHistory.map((item) => {
                  const session = item.screening_sessions || {}
                  const jd = session.jd_posts || {}
                  const jdTitle = jd.title || item.jd_title || 'Interview feedback'
                  const dimensionFeedback = item.dimension_feedback || {}
                  const tips = item.coaching_tips || []
                  const improvements = item.improvement_areas || []
                  const recommendations = item.recommended_jds || []
                  return (
                    <div key={item.id || item.session_id} className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-5">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <h2 className="text-lg font-semibold text-gray-900">{jdTitle}</h2>
                          <p className="text-xs text-gray-400 mt-1">
                            {item.created_at ? new Date(item.created_at).toLocaleDateString() : 'Date unavailable'}
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-xs text-gray-400 font-medium">Overall score</p>
                          <p className={`text-3xl font-bold ${
                            (item.overall_score ?? 0) >= 80 ? 'text-teal-600'
                              : (item.overall_score ?? 0) >= 60 ? 'text-amber-600'
                              : 'text-red-500'
                          }`}>
                            {Math.round(item.overall_score ?? 0)}
                          </p>
                        </div>
                      </div>

                      {item.overall_message && (
                        <p className="text-sm text-gray-600 bg-gray-50 border border-gray-100 rounded-xl p-4">
                          {item.overall_message}
                        </p>
                      )}

                      <div>
                        <h3 className="text-sm font-semibold text-gray-800 mb-3">Dimension feedback</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          {Object.entries(FEEDBACK_DIMENSION_LABELS).map(([key, label]) => (
                            <div key={key} className="border border-gray-200 rounded-xl p-4">
                              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">{label}</p>
                              <p className="text-sm text-gray-700">{dimensionFeedback[key] || 'No feedback available for this dimension.'}</p>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                        <div>
                          <h3 className="text-sm font-semibold text-gray-800 mb-2">Coaching tips</h3>
                          {tips.length === 0 ? (
                            <p className="text-sm text-gray-400">No coaching tips available.</p>
                          ) : (
                            <ul className="space-y-2">
                              {tips.map((tip, i) => (
                                <li key={i} className="text-sm text-gray-700 flex gap-2">
                                  <span className="text-teal-600 font-semibold">{i + 1}.</span>
                                  <span>{tip}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>

                        <div>
                          <h3 className="text-sm font-semibold text-gray-800 mb-2">Improvement areas</h3>
                          {improvements.length === 0 ? (
                            <p className="text-sm text-gray-400">No improvement areas available.</p>
                          ) : (
                            <div className="space-y-3">
                              {improvements.map((area, i) => (
                                <div key={i} className="bg-amber-50 border border-amber-100 rounded-xl p-3">
                                  <p className="text-sm font-semibold text-amber-800">{area.area || 'Focus area'}</p>
                                  {area.current && <p className="text-xs text-amber-700 mt-1">{area.current}</p>}
                                  <p className="text-sm text-gray-700 mt-1">{area.suggestion || 'Prepare a specific example for this area.'}</p>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>

                      {item.next_steps && (
                        <div className="border-t border-gray-100 pt-4">
                          <h3 className="text-sm font-semibold text-gray-800 mb-1">Next steps</h3>
                          <p className="text-sm text-gray-600">{item.next_steps}</p>
                        </div>
                      )}

                      <div className="border-t border-gray-100 pt-4">
                        <h3 className="text-sm font-semibold text-gray-800 mb-3">Recommended jobs</h3>
                        {recommendations.length === 0 ? (
                          <p className="text-sm text-gray-400">No suitable job recommendations available yet.</p>
                        ) : (
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                            {recommendations.map((job) => (
                              <button
                                key={job.jd_id}
                                onClick={() => { setJobSearch(job.jd_title || ''); setActiveTab('browse') }}
                                className="text-left border border-gray-200 rounded-xl p-4 hover:border-teal-300 hover:bg-teal-50/40 transition-colors"
                              >
                                <p className="text-sm font-semibold text-gray-900">{job.jd_title || 'Untitled role'}</p>
                                <p className="text-xs text-gray-400 mt-1">
                                  {[job.department, job.location].filter(Boolean).join(' · ') || 'Details unavailable'}
                                </p>
                                <p className="text-xs text-teal-700 font-semibold mt-3">
                                  Match {Math.round(job.match_score ?? 0)}%
                                </p>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* ══ ANALYSE RESUME ══ */}
        {activeTab === 'analyse' && (
          <div className="max-w-4xl mx-auto px-6 py-10 space-y-8">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Analyse Resume</h1>
              <p className="text-sm text-gray-500 mt-1">Score your resume against a specific job description.</p>
            </div>

            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-4">
              {candidate ? (
                <div className="flex items-center gap-2 text-sm text-gray-600 bg-teal-50 border border-teal-200 rounded-lg px-3 py-2">
                  <span className="text-teal-600 font-bold">✓</span>
                  <span>Using resume for <strong>{candidate.name}</strong></span>
                </div>
              ) : (
                <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex items-center gap-2">
                  ⚠ No resume found.{' '}
                  <button onClick={() => setActiveTab('profile')} className="underline font-medium">
                    Upload one first →
                  </button>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Select target job</label>
                <select
                  value={selectedJd}
                  onChange={(e) => { setSelectedJd(e.target.value); setResult(null) }}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                >
                  <option value="">— choose a job posting —</option>
                  {jdPosts.map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.title}{j.department ? ` · ${j.department}` : ''}{j.location ? ` (${j.location})` : ''}
                    </option>
                  ))}
                </select>
              </div>

              {analysisError && <p className="text-sm text-red-600">{analysisError}</p>}

              <div className="flex items-center gap-4">
                <button
                  onClick={() => handleAnalyse(false)}
                  disabled={!canAnalyse}
                  className="bg-teal-600 hover:bg-teal-700 disabled:bg-gray-300 text-white font-semibold px-5 py-2 rounded-lg text-sm transition-colors flex items-center gap-2"
                >
                  {analysing && (
                    <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                  )}
                  {analysing ? 'Analysing…' : 'Analyse My Resume'}
                </button>
                {result && (
                  <button onClick={() => handleAnalyse(true)} className="text-sm text-gray-400 hover:text-gray-600 underline">
                    Re-analyse
                  </button>
                )}
              </div>
              <p className="text-xs text-gray-400">Uses AI credits — results are cached after first run.</p>
            </div>

            {result && (
              <>
                <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="text-lg font-semibold text-gray-800">Resume Scorecard</h2>
                      {selectedJdTitle && <p className="text-xs text-gray-400 mt-0.5">vs. {selectedJdTitle}</p>}
                    </div>
                    {result.from_cache && (
                      <span className="text-xs bg-blue-50 text-blue-600 border border-blue-200 px-2.5 py-1 rounded-full">
                        Cached
                      </span>
                    )}
                  </div>
                  <div className="text-center space-y-3">
                    <GradeBadge grade={result.overall_grade} />
                    <p className="text-sm text-gray-600 max-w-lg mx-auto">{result.overall_summary}</p>
                  </div>
                  <div className="space-y-3">
                    {Object.entries(SCORE_LABELS).map(([key, label]) => (
                      <ScoreBar key={key} label={label} score={result.scores?.[key] ?? 0} />
                    ))}
                  </div>
                  {result.missing_keywords?.length > 0 && (
                    <div>
                      <p className="text-sm font-medium text-gray-700 mb-2">Missing keywords</p>
                      <div className="flex flex-wrap gap-2">
                        {result.missing_keywords.map((kw, i) => (
                          <span key={i} className="text-xs bg-gray-100 text-gray-600 px-2.5 py-1 rounded-full">{kw}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
                    <h2 className="text-lg font-semibold text-gray-800 mb-4">Bullet Rewrites</h2>
                    {result.weak_bullets?.length === 0 ? (
                      <p className="text-sm text-gray-500">No weak bullets detected.</p>
                    ) : (
                      <div className="space-y-4">
                        {result.weak_bullets?.map((b, i) => (
                          <div key={i}>
                            <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-1">
                              <p className="text-xs font-semibold text-red-500 mb-1">Before</p>
                              <p className="text-sm text-gray-700">{b.original}</p>
                            </div>
                            <div className="flex justify-center my-1"><span className="text-gray-400 text-xs">▼</span></div>
                            <div className="bg-green-50 border border-green-200 rounded-lg p-3">
                              <p className="text-xs font-semibold text-green-600 mb-1">After</p>
                              <p className="text-sm text-gray-700">{b.rewritten}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
                    <h2 className="text-lg font-semibold text-gray-800 mb-3">Coaching Tips</h2>
                    <ol className="space-y-2">
                      {result.coaching_tips?.map((tip, i) => (
                        <li key={i} className="flex gap-3 text-sm text-gray-700">
                          <span className="w-5 h-5 rounded-full bg-teal-100 text-teal-700 flex items-center justify-center font-bold text-xs shrink-0 mt-0.5">
                            {i + 1}
                          </span>
                          {tip}
                        </li>
                      ))}
                    </ol>
                  </div>
                </div>
              </>
            )}

            {!result && !analysing && (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="text-5xl mb-4">🔍</div>
                <p className="text-gray-500 text-sm max-w-xs">
                  Select a job posting above and click <strong>Analyse My Resume</strong> to get your AI-powered scorecard.
                </p>
              </div>
            )}
          </div>
        )}

        {/* ══ RESUME HISTORY ══ */}
        {activeTab === 'history' && (
          <div className="max-w-3xl mx-auto px-6 py-10 space-y-6">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Analysis History</h1>
              <p className="text-sm text-gray-500 mt-1">Track how your resume score improves over time.</p>
            </div>

            {history.length === 0 ? (
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-10 text-center">
                <div className="text-4xl mb-3">📊</div>
                <p className="text-gray-500 text-sm">
                  No analysis history yet.{' '}
                  <button onClick={() => setActiveTab('analyse')} className="text-teal-600 underline font-medium">
                    Run your first analysis →
                  </button>
                </p>
              </div>
            ) : (
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200">
                      <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Ver</th>
                      <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Grade</th>
                      <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">JD Match</th>
                      <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Job</th>
                      <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h, i) => (
                      <tr key={h.id} className={`border-b border-gray-100 ${i % 2 === 0 ? '' : 'bg-gray-50/50'}`}>
                        <td className="px-5 py-3 text-gray-600 font-mono">v{h.version}</td>
                        <td className="px-5 py-3 font-bold text-gray-900">{h.overall_grade}</td>
                        <td className="px-5 py-3">
                          <span className={`font-semibold ${h.jd_match >= 70 ? 'text-green-600' : h.jd_match >= 50 ? 'text-amber-500' : 'text-red-500'}`}>
                            {h.jd_match}%
                          </span>
                        </td>
                        <td className="px-5 py-3 text-gray-600 truncate max-w-[180px]">{h.jd_title || '—'}</td>
                        <td className="px-5 py-3 text-gray-400">{new Date(h.created_at).toLocaleDateString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ══ SCREENING HISTORY ══ */}
        {activeTab === 'screening' && (
          <div className="max-w-3xl mx-auto px-6 py-10 space-y-6">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Screening History</h1>
              <p className="text-sm text-gray-500 mt-1">
                Look up your AI interview results by the email you used during screening.
              </p>
            </div>

            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-4">
              {historyEmail ? (
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-sm text-gray-500">
                    Showing results for <strong>{historyEmail}</strong>
                  </span>
                  <button onClick={() => loadScreeningHistory(historyEmail)} className="text-xs text-teal-600 hover:text-teal-700 underline">
                    Refresh
                  </button>
                  <button onClick={handleClearHistory} className="text-xs text-gray-400 hover:text-gray-600 underline">
                    Clear
                  </button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <input
                    type="email"
                    placeholder="Enter the email you used during screening"
                    value={historyEmailInput}
                    onChange={(e) => setHistoryEmailInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleLookup()}
                    className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                  />
                  <button
                    onClick={handleLookup}
                    disabled={!historyEmailInput.trim()}
                    className="bg-teal-600 hover:bg-teal-700 disabled:bg-gray-300 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
                  >
                    Look up
                  </button>
                </div>
              )}

              {historyLoading ? (
                <LoadingSpinner label="Loading screening history…" />
              ) : pastSessions.length === 0 && historyEmail ? (
                <div className="text-center py-8">
                  <p className="text-sm text-gray-400">No completed screenings found for {historyEmail}</p>
                </div>
              ) : pastSessions.length > 0 ? (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500 border-b border-gray-100 text-xs">
                      <th className="pb-2 font-medium">Role</th>
                      <th className="pb-2 font-medium">Score</th>
                      <th className="pb-2 font-medium">Grade</th>
                      <th className="pb-2 font-medium">Recommendation</th>
                      <th className="pb-2 font-medium">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pastSessions.map((s) => (
                      <tr key={s.session_id} className="border-b border-gray-50 hover:bg-gray-50">
                        <td className="py-3 font-medium text-gray-800">{s.jd_title}</td>
                        <td className="py-3">
                          <span className={`font-semibold ${
                            (s.overall_score ?? 0) >= 80 ? 'text-teal-600'
                              : (s.overall_score ?? 0) >= 60 ? 'text-amber-600'
                              : 'text-red-500'
                          }`}>
                            {s.overall_score ?? '—'}/100
                          </span>
                        </td>
                        <td className="py-3">
                          <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${
                            s.overall_grade === 'A' ? 'bg-teal-50 text-teal-700'
                              : s.overall_grade === 'B' ? 'bg-blue-50 text-blue-700'
                              : s.overall_grade === 'C' ? 'bg-amber-50 text-amber-700'
                              : 'bg-red-50 text-red-600'
                          }`}>
                            {s.overall_grade ?? '—'}
                          </span>
                        </td>
                        <td className="py-3 text-gray-500 capitalize">
                          {s.hire_recommendation?.replace('_', ' ') ?? '—'}
                        </td>
                        <td className="py-3 text-gray-400 text-xs">
                          {new Date(s.created_at).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : !historyEmail ? (
                <div className="text-center py-8">
                  <div className="text-4xl mb-3">🎙️</div>
                  <p className="text-sm text-gray-400">
                    Enter the email you used when completing a screening above.
                  </p>
                </div>
              ) : null}
            </div>
          </div>
        )}

      </main>

      <CandidateChatAgent />
    </div>
  )
}
