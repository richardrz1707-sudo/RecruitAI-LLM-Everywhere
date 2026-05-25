import { useState, useEffect } from 'react'
import ResumeUpload from '../components/ResumeUpload'
import GradeBadge from '../components/GradeBadge'
import ScoreBar from '../components/ScoreBar'
import { uploadResume, getAllCandidates, getPublicJDList, analyseResume, getAnalysisHistory } from '../lib/api'
import { useAuthStore } from '../lib/auth'

const SCORE_LABELS = {
  jd_match: 'Job description match',
  ats_score: 'ATS compatibility',
  impact_score: 'Impact & numbers',
  language_score: 'Language strength',
  structure_score: 'Resume structure',
}

const NAV_ITEMS = [
  { id: 'upload',  label: 'Upload Resume', icon: '📤' },
  { id: 'analyse', label: 'Analyse Resume', icon: '🔍' },
  { id: 'history', label: 'History',        icon: '📊' },
]

export default function CandidateDashboard() {
  const { user, fullName } = useAuthStore()

  // Sidebar active tab
  const [activeTab, setActiveTab] = useState('upload')

  // Upload state
  const [name, setName]                   = useState(fullName || '')
  const [email, setEmail]                 = useState(user?.email || '')
  const [file, setFile]                   = useState(null)
  const [uploading, setUploading]         = useState(false)
  const [uploadSuccess, setUploadSuccess] = useState('')
  const [uploadError, setUploadError]     = useState('')

  // Profile + JD state
  const [myProfile, setMyProfile]                 = useState(null)
  const [jdPosts, setJdPosts]                     = useState([])
  const [jdError, setJdError]                     = useState('')
  const [selectedCandidate, setSelectedCandidate] = useState('')
  const [selectedJd, setSelectedJd]               = useState('')

  // Analysis state
  const [analysing, setAnalysing]           = useState(false)
  const [result, setResult]                 = useState(null)
  const [analysisError, setAnalysisError]   = useState('')
  const [history, setHistory]               = useState([])

  useEffect(() => {
    getAllCandidates()
      .then((r) => {
        const all  = r.data?.data?.candidates || []
        const mine = all.find((c) => c.email?.toLowerCase() === user?.email?.toLowerCase())
        if (mine) {
          setMyProfile(mine)
          setSelectedCandidate(mine.id)
          loadHistory(mine.id)
        }
      })
      .catch(() => {})

    getPublicJDList()
      .then((r) => {
        const jds = r.data?.data?.jd_posts || []
        setJdPosts(jds)
        if (!jds.length) setJdError('No active job postings available right now.')
      })
      .catch(() => setJdError('Could not load job postings. Please try again.'))
  }, [user?.email]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadHistory = (candidateId) => {
    getAnalysisHistory(candidateId)
      .then((r) => setHistory(r.data?.data?.history || []))
      .catch(() => {})
  }

  const handleUpload = async () => {
    if (!name.trim() || !email.trim() || !file) return
    setUploading(true)
    setUploadError('')
    setUploadSuccess('')
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('name', name)
      formData.append('email', email)
      await uploadResume(formData)
      setUploadSuccess('Resume uploaded successfully!')
      setFile(null)
      const r    = await getAllCandidates()
      const all  = r.data?.data?.candidates || []
      const mine = all.find((c) => c.email?.toLowerCase() === user?.email?.toLowerCase())
      if (mine) { setMyProfile(mine); setSelectedCandidate(mine.id) }
    } catch (e) {
      setUploadError(e.response?.data?.detail || 'Upload failed. Please try again.')
    } finally {
      setUploading(false)
    }
  }

  const handleAnalyse = async (forceRefresh = false) => {
    if (!selectedCandidate || !selectedJd) return
    setAnalysing(true)
    setAnalysisError('')
    setResult(null)
    try {
      const r = await analyseResume(selectedCandidate, selectedJd, forceRefresh)
      setResult(r.data)
      loadHistory(selectedCandidate)
    } catch (e) {
      setAnalysisError(e.response?.data?.detail || 'Analysis failed. Please try again.')
    } finally {
      setAnalysing(false)
    }
  }

  const canAnalyse = myProfile && selectedJd && !analysing
  const selectedJdTitle = jdPosts.find((j) => j.id === selectedJd)?.title || ''

  return (
    <div className="flex min-h-[calc(100vh-64px)] bg-gray-50">

      {/* ── Sidebar ── */}
      <aside className="w-64 shrink-0 bg-white border-r border-gray-200 flex flex-col py-6 px-3">
        {/* User avatar */}
        <div className="mb-6 px-3">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">My Dashboard</p>
          {myProfile ? (
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-teal-100 flex items-center justify-center text-teal-700 font-bold text-sm shrink-0">
                {myProfile.name?.[0]?.toUpperCase() || '?'}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-800 truncate">{myProfile.name}</p>
                <p className="text-xs text-gray-400 truncate">{myProfile.email}</p>
              </div>
            </div>
          ) : (
            <p className="text-xs text-amber-600">No resume uploaded yet</p>
          )}
        </div>

        {/* Nav items */}
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
              {item.id === 'history' && history.length > 0 && (
                <span className="ml-auto text-xs bg-teal-100 text-teal-700 rounded-full px-1.5 py-0.5 font-semibold">
                  {history.length}
                </span>
              )}
            </button>
          ))}
        </nav>

        {/* Resume link at bottom */}
        <div className="mt-auto px-3 pt-6">
          {myProfile?.resume_url ? (
            <a
              href={myProfile.resume_url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-teal-600 hover:text-teal-800 font-medium underline"
            >
              📄 View current resume ↗
            </a>
          ) : (
            <p className="text-xs text-gray-400">Upload a resume to get started.</p>
          )}
        </div>
      </aside>

      {/* ── Main content ── */}
      <main className="flex-1 overflow-y-auto">

        {/* ══ UPLOAD tab ══ */}
        {activeTab === 'upload' && (
          <div className="max-w-2xl mx-auto px-6 py-10 space-y-6">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Upload Resume</h1>
              <p className="text-sm text-gray-500 mt-1">
                Submit your resume so our AI can match it against job descriptions.
              </p>
            </div>

            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Jane Smith"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="jane@example.com"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                  />
                </div>
              </div>

              <ResumeUpload onFileSelected={setFile} />

              {uploadError && <p className="text-sm text-red-600">{uploadError}</p>}
              {uploadSuccess && (
                <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                  <span className="font-bold">✓</span> {uploadSuccess}
                  <button
                    onClick={() => { setActiveTab('analyse'); setUploadSuccess('') }}
                    className="ml-auto text-xs text-teal-600 hover:text-teal-800 font-medium underline"
                  >
                    Go to Analyse →
                  </button>
                </div>
              )}

              <button
                onClick={handleUpload}
                disabled={!name.trim() || !email.trim() || !file || uploading}
                className="bg-teal-600 hover:bg-teal-700 disabled:bg-gray-300 text-white font-semibold px-5 py-2 rounded-lg text-sm transition-colors"
              >
                {uploading ? 'Uploading…' : 'Upload Resume'}
              </button>
            </div>
          </div>
        )}

        {/* ══ ANALYSE tab ══ */}
        {activeTab === 'analyse' && (
          <div className="max-w-4xl mx-auto px-6 py-10 space-y-8">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Analyse Resume</h1>
              <p className="text-sm text-gray-500 mt-1">
                Select a job posting and let AI score your resume against it.
              </p>
            </div>

            {/* Setup card */}
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-4">
              {myProfile ? (
                <div className="flex items-center gap-2 text-sm text-gray-600 bg-teal-50 border border-teal-200 rounded-lg px-3 py-2">
                  <span className="text-teal-600 font-bold">✓</span>
                  <span>Using resume for <strong>{myProfile.name}</strong></span>
                </div>
              ) : (
                <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex items-center gap-2">
                  ⚠ No resume found.{' '}
                  <button onClick={() => setActiveTab('upload')} className="underline font-medium">
                    Upload one first →
                  </button>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Select target job</label>
                {jdError ? (
                  <p className="text-sm text-red-600">{jdError}</p>
                ) : (
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
                )}
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
                  <button
                    onClick={() => handleAnalyse(true)}
                    className="text-sm text-gray-400 hover:text-gray-600 underline"
                  >
                    Re-analyse
                  </button>
                )}
              </div>
              <p className="text-xs text-gray-400">Uses AI credits — results are cached after first run</p>
            </div>

            {/* Scorecard */}
            {result && (
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-gray-800">Resume Scorecard</h2>
                    {selectedJdTitle && <p className="text-xs text-gray-400 mt-0.5">vs. {selectedJdTitle}</p>}
                  </div>
                  {result.from_cache && (
                    <span className="text-xs bg-blue-50 text-blue-600 border border-blue-200 px-2.5 py-1 rounded-full">
                      Loaded from cache
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
                        <span key={i} className="text-xs bg-gray-100 text-gray-600 px-2.5 py-1 rounded-full">
                          {kw}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Coaching panel */}
            {result && (
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
                          <div className="flex justify-center my-1">
                            <span className="text-gray-400 text-xs">▼</span>
                          </div>
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
            )}

            {/* Empty state */}
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

        {/* ══ HISTORY tab ══ */}
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

      </main>
    </div>
  )
}
