import { useState, useEffect, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { startScreening, registerCandidate, submitScreeningAnswer } from '../lib/api'

const GRADE_STYLES = {
  A: 'text-green-700 bg-green-50 border-green-300',
  B: 'text-teal-700 bg-teal-50 border-teal-300',
  C: 'text-amber-700 bg-amber-50 border-amber-300',
  D: 'text-red-700 bg-red-50 border-red-300',
  F: 'text-red-700 bg-red-50 border-red-300',
}

// Filler word patterns — regex variants catch extended forms (umm, ermmm, ahh, etc.)
// [display_label, regex_source] — compiled fresh per call to avoid lastIndex state issues
const FILLER_PATTERNS = [
  ['um/umm',    'um+'],       // um, umm, ummm…
  ['uh/uhh',    'uh+'],       // uh, uhh…
  ['ah/ahh',    'ah+'],       // ah, ahh, ahhh…
  ['er/erm',    'er+m*'],     // er, err, erm, ermmm…
  ['hm/hmm',    'hm+'],       // hm, hmm, hmmm…
  ['like',      'like'],
  ['you know',  'you know'],
  ['basically', 'basically'],
  ['literally', 'literally'],
  ['actually',  'actually'],
  ['right',     'right'],
  ['so',        'so'],
  ['well',      'well'],
  ['kind of',   'kind of'],
  ['sort of',   'sort of'],
  ['i mean',    'i mean'],
]

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length
}

function countFillerWords(text) {
  const lower = text.toLowerCase()
  let count = 0
  const used = []
  FILLER_PATTERNS.forEach(([label, pattern]) => {
    // Compile fresh each call — global regex retains lastIndex between calls otherwise
    const regex = new RegExp(`\\b${pattern}\\b`, 'gi')
    const matches = lower.match(regex)
    if (matches) {
      count += matches.length
      used.push(label)
    }
  })
  return { count, used }
}

function buildSpeechMetrics(finalText, durationSeconds) {
  const wc = wordCount(finalText)
  const { count: fillerCount, used: fillerUsed } = countFillerWords(finalText)
  const wpm = durationSeconds > 0 ? Math.round((wc / durationSeconds) * 60) : null
  return {
    duration_seconds: Math.round(durationSeconds),
    word_count: wc,
    filler_word_count: fillerCount,
    filler_words_used: fillerUsed,
    words_per_minute: wpm,
    final_transcript: finalText,
  }
}

// ── Web Speech API hook (browser-native, zero cost) ──────────────────────
function useSpeechRecognition(onTranscriptUpdate, onStop) {
  const recognitionRef = useRef(null)
  const [isRecording, setIsRecording] = useState(false)
  const startTimeRef = useRef(null)

  const startRecording = () => {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition) {
      alert(
        'Speech recognition is not supported in this browser. ' +
        'Please use Chrome or Edge, or ask the recruiter to switch to text mode.',
      )
      return
    }

    const recognition = new SpeechRecognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-US'
    recognition.maxAlternatives = 1

    let finalTranscript = ''

    recognition.onresult = (event) => {
      let interimTranscript = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript
        if (event.results[i].isFinal) {
          finalTranscript += transcript + ' '
        } else {
          interimTranscript += transcript
        }
      }
      onTranscriptUpdate(finalTranscript + interimTranscript, finalTranscript)
    }

    recognition.onerror = (event) => {
      if (event.error === 'not-allowed') {
        alert('Microphone access denied. Please allow microphone access in your browser.')
      }
      setIsRecording(false)
    }

    recognition.onend = () => {
      setIsRecording(false)
      if (startTimeRef.current) {
        const duration = (Date.now() - startTimeRef.current) / 1000
        onStop(finalTranscript.trim(), duration)
      }
    }

    recognitionRef.current = recognition
    startTimeRef.current = Date.now()
    recognition.start()
    setIsRecording(true)
  }

  const stopRecording = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop()
    }
  }

  return { isRecording, startRecording, stopRecording }
}

// ── Integrity Agreement Modal ─────────────────────────────────────────────
function IntegrityAgreementModal({ onAgree, onCancel, loading, error }) {
  const [checked, setChecked] = useState(false)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-60">
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-[520px] p-8 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-center space-y-1.5">
          <div className="text-4xl">⚠️</div>
          <h2 className="text-xl font-bold text-gray-900">
            Academic &amp; Professional Integrity Agreement
          </h2>
          <p className="text-sm text-gray-500">Please read carefully before proceeding</p>
        </div>

        <div className="max-h-80 overflow-y-auto space-y-4 text-sm text-gray-700 leading-relaxed pr-1">
          <div>
            <p className="font-semibold text-gray-900 mb-1">This screening is monitored</p>
            <p className="mb-2">
              This AI screening session employs real-time integrity monitoring. The
              following are tracked throughout your session:
            </p>
            <ul className="list-disc list-inside space-y-1 text-gray-600">
              <li>Response timing — how long you take to answer each question</li>
              <li>Tab and window switching — if you navigate away during the interview</li>
              <li>AI-generated content detection — whether answers appear to be written by AI tools</li>
            </ul>
          </div>

          <div>
            <p className="font-semibold text-gray-900 mb-1">Prohibited actions</p>
            <p className="mb-2">The following are strictly prohibited during this screening:</p>
            <ul className="list-disc list-inside space-y-1 text-gray-600">
              <li>Using ChatGPT, Claude, Gemini, or any AI tool to assist your answers</li>
              <li>Reading from physical or digital notes during your response</li>
              <li>Being coached or prompted by another person during the session</li>
              <li>Searching the internet for answers during the session</li>
            </ul>
          </div>

          <div>
            <p className="font-semibold text-gray-900 mb-1">Consequences</p>
            <p>
              If integrity concerns are detected, a detailed flag report is shared with
              the hiring team. Flagged candidates may be disqualified or required to
              complete an additional verification interview.
            </p>
          </div>

          <div>
            <p className="font-semibold text-gray-900 mb-1">Your best performance</p>
            <p>
              We encourage you to answer honestly and in your own words. Authentic
              answers — even imperfect ones — give the hiring team a genuine picture of
              your abilities.
            </p>
          </div>
        </div>

        <label className="flex items-start gap-3 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="mt-0.5 w-4 h-4 accent-teal-600 flex-shrink-0"
          />
          <span className="text-sm text-gray-700 leading-relaxed">
            I have read and understood this agreement. I confirm that all answers I
            provide will be my own original work, and I will not use AI tools or external
            assistance during this screening.
          </span>
        </label>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-3">
          <button
            onClick={onCancel}
            disabled={loading}
            className="flex-1 border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-50 text-gray-700 font-semibold py-2.5 rounded-lg text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => checked && onAgree()}
            disabled={!checked || loading}
            className="flex-1 bg-teal-600 hover:bg-teal-700 disabled:bg-gray-300 text-white font-semibold py-2.5 rounded-lg text-sm transition-colors flex items-center justify-center gap-2"
          >
            {loading && (
              <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
            )}
            {loading ? 'Starting…' : 'I Agree — Begin Screening'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────
export default function ScreeningPage() {
  const { token } = useParams()

  // Token / JD info
  const [loadingJd, setLoadingJd] = useState(true)
  const [linkError, setLinkError] = useState('')
  const [jdTitle, setJdTitle] = useState('')
  const [interviewType, setInterviewType] = useState('open_link')   // 'direct_invite' | 'open_link'
  const [resumePreloaded, setResumePreloaded] = useState(false)
  // Views: welcome | interview | complete
  const [view, setView] = useState('welcome')

  // Welcome form state (persisted across modal open/cancel)
  const [candidateName, setCandidateName] = useState('')
  const [candidateEmail, setCandidateEmail] = useState('')
  const [resumeText, setResumeText] = useState('')

  // Modal state
  const [showAgreementModal, setShowAgreementModal] = useState(false)
  const [registering, setRegistering] = useState(false)
  const [registerError, setRegisterError] = useState('')

  // Interview state
  const [sessionId, setSessionId] = useState(null)
  const [currentQuestion, setCurrentQuestion] = useState(null)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [totalQuestions, setTotalQuestions] = useState(5)
  const [answer, setAnswer] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [answerError, setAnswerError] = useState('')
  const [isFollowup, setIsFollowup] = useState(false)
  const [followupQuestion, setFollowupQuestion] = useState('')

  // Complete state
  const [finalScore, setFinalScore] = useState(null)
  const [finalGrade, setFinalGrade] = useState(null)
  const [headline, setHeadline] = useState('')

  // Recording duration timer
  const [recordingDuration, setRecordingDuration] = useState(0)
  const recordingTimerRef = useRef(null)

  // Speech metrics (accumulated per answer, sent with submission)
  const speechMetricsRef = useRef(null)

  // ── Tier 1: Integrity signal tracking refs ────────────────────────────
  const questionShownAtRef = useRef(null)
  const firstKeystrokeAtRef = useRef(null)
  const tabSwitchesRef = useRef([])
  const tabLeftAtRef = useRef(null)

  // ── Speech recognition hook ───────────────────────────────────────────
  const { isRecording, startRecording, stopRecording } = useSpeechRecognition(
    (fullTranscript) => {
      // Update answer with the combined interim+final transcript
      setAnswer(fullTranscript)
    },
    (finalText, durationSeconds) => {
      // Called when recording ends — build metrics (no Claude call)
      speechMetricsRef.current = buildSpeechMetrics(finalText, durationSeconds)
    },
  )

  // ── Recording duration timer ──────────────────────────────────────────
  // Must be after useSpeechRecognition so isRecording is in scope
  useEffect(() => {
    if (isRecording) {
      setRecordingDuration(0)
      recordingTimerRef.current = setInterval(() => {
        setRecordingDuration((d) => d + 1)
      }, 1000)
    } else {
      clearInterval(recordingTimerRef.current)
    }
    return () => clearInterval(recordingTimerRef.current)
  }, [isRecording])

  // Set up/tear down integrity tracking whenever the displayed question changes
  useEffect(() => {
    if (view !== 'interview') return

    questionShownAtRef.current = Date.now()
    firstKeystrokeAtRef.current = null
    tabSwitchesRef.current = []
    tabLeftAtRef.current = null
    speechMetricsRef.current = null

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        tabLeftAtRef.current = Date.now()
      } else if (document.visibilityState === 'visible' && tabLeftAtRef.current !== null) {
        const returnedAt = Date.now()
        const durationMs = returnedAt - tabLeftAtRef.current
        tabSwitchesRef.current = [
          ...tabSwitchesRef.current,
          { left_at: tabLeftAtRef.current, returned_at: returnedAt, duration_ms: durationMs },
        ]
        tabLeftAtRef.current = null
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      stopRecording() // safe no-op if not recording
      if (tabLeftAtRef.current !== null) {
        const returnedAt = Date.now()
        const durationMs = returnedAt - tabLeftAtRef.current
        tabSwitchesRef.current = [
          ...tabSwitchesRef.current,
          { left_at: tabLeftAtRef.current, returned_at: returnedAt, duration_ms: durationMs },
        ]
        tabLeftAtRef.current = null
      }
    }
  }, [currentQuestion, isFollowup, view]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleKeyDown = () => {
    if (!firstKeystrokeAtRef.current) {
      firstKeystrokeAtRef.current = Date.now()
    }
  }

  const buildIntegritySignals = (submittedAt) => {
    const totalTimeAway = tabSwitchesRef.current.reduce((sum, s) => sum + s.duration_ms, 0)
    return {
      time_to_first_keystroke_ms:
        firstKeystrokeAtRef.current && questionShownAtRef.current
          ? firstKeystrokeAtRef.current - questionShownAtRef.current
          : null,
      total_response_time_ms: questionShownAtRef.current
        ? submittedAt - questionShownAtRef.current
        : null,
      answer_word_count: wordCount(answer),
      tab_switch_count: tabSwitchesRef.current.length,
      total_time_away_ms: totalTimeAway,
    }
  }

  // ── JD verification on mount ──────────────────────────────────────────
  useEffect(() => {
    if (!token) return
    const load = async () => {
      try {
        const res = await startScreening(token)
        const data = res.data
        setJdTitle(data.jd_title)
        setInterviewType(data.invite_type || 'open_link')
        setResumePreloaded(data.has_resume || false)
        // Pre-fill name and email for direct invites
        if (data.invite_type === 'direct_invite') {
          if (data.candidate_name) setCandidateName(data.candidate_name)
          if (data.candidate_email) setCandidateEmail(data.candidate_email)
        }
        setLoadingJd(false)
      } catch (err) {
        const status = err.response?.status
        if (status === 410) {
          setLinkError('This invite has expired. Please contact the recruiter for a new link.')
        } else if (status === 409) {
          setLinkError('You have already completed this screening. Check your email for recruiter updates.')
        } else {
          setLinkError('Invalid or expired invite link.')
        }
        setLoadingJd(false)
      }
    }
    load()
  }, [token])

  // ── View 1: "Begin Screening" click ──────────────────────────────────
  const handleBeginClick = () => {
    if (!candidateName.trim() || !candidateEmail.trim()) return
    setRegisterError('')
    setShowAgreementModal(true)
  }

  // ── Modal: "I Agree" click ────────────────────────────────────────────
  const handleAgreeAndStart = async () => {
    const agreedAt = new Date().toISOString()
    setRegistering(true)
    setRegisterError('')
    try {
      const r = await registerCandidate({
        token,
        candidate_name: candidateName,
        candidate_email: candidateEmail,
        resume_text: resumeText,
        integrity_agreed: true,
        agreement_version: '1.0',
        agreed_at: agreedAt,
      })
      setShowAgreementModal(false)
      setSessionId(r.data.session_id)
      const fq = r.data.first_question
      setCurrentQuestion(fq)
      setCurrentIndex(0)
      setTotalQuestions(fq?.total_questions ?? 5)
      setView('interview')
    } catch (e) {
      setRegisterError(
        e.response?.data?.detail || 'Could not start session. Please try again.',
      )
    } finally {
      setRegistering(false)
    }
  }

  const handleModalCancel = () => {
    setShowAgreementModal(false)
    setRegisterError('')
  }

  // ── Interview: submit answer ──────────────────────────────────────────
  const handleSubmitAnswer = async () => {
    if (wordCount(answer) < 10) {
      setAnswerError('Please write at least 10 words before submitting.')
      return
    }
    if (isRecording) {
      setAnswerError('Please stop recording before submitting.')
      return
    }

    const submittedAt = Date.now()
    const integritySignals = buildIntegritySignals(submittedAt)
    const speechMetrics = speechMetricsRef.current // null for text_only

    setSubmitting(true)
    setAnswerError('')
    try {
      const r = await submitScreeningAnswer(
        sessionId,
        currentQuestion.id,
        answer.trim(),
        isFollowup,
        integritySignals,
        speechMetrics,
      )
      setAnswer('')
      setRecordingDuration(0)
      speechMetricsRef.current = null // reset for next question

      if (r.data.is_complete) {
        setFinalScore(r.data.final_score)
        setFinalGrade(r.data.final_grade)
        setHeadline(r.data.headline)
        // Persist email so CandidateDashboard can restore history after logout
        if (candidateEmail) {
          localStorage.setItem('recruitai_candidate_email', candidateEmail.toLowerCase().trim())
        }
        setView('complete')
      } else if (r.data.needs_followup) {
        setFollowupQuestion(r.data.follow_up_question)
        setIsFollowup(true)
      } else {
        setCurrentQuestion(r.data.next_question)
        setCurrentIndex(r.data.current_index)
        setIsFollowup(false)
        setFollowupQuestion('')
      }
    } catch (e) {
      setAnswerError(
        e.response?.data?.detail || 'Submission failed. Please try again.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  // ── Loading ──────────────────────────────────────────────────────────────
  if (loadingJd) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center">
        <div className="text-center space-y-3">
          <svg className="animate-spin w-8 h-8 text-blue-500 mx-auto" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          <p className="text-gray-500 text-sm">Loading screening…</p>
        </div>
      </div>
    )
  }

  if (linkError) {
    const isExpired   = linkError.includes('expired')
    const isCompleted = linkError.includes('already completed')
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg p-8 max-w-sm text-center space-y-4">
          <div className="text-4xl">{isCompleted ? '✅' : isExpired ? '⏰' : '❌'}</div>
          <h1 className="text-xl font-bold text-gray-900">
            {isCompleted ? 'Already Completed' : isExpired ? 'Invite Expired' : 'Link Not Found'}
          </h1>
          <p className="text-sm text-gray-600">{linkError}</p>
        </div>
      </div>
    )
  }

  const wc = wordCount(answer)
  const fillerCount = countFillerWords(answer).count

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">

      {/* Agreement modal — rendered on top of everything */}
      {showAgreementModal && (
        <IntegrityAgreementModal
          onAgree={handleAgreeAndStart}
          onCancel={handleModalCancel}
          loading={registering}
          error={registerError}
        />
      )}

      <div className="w-full max-w-lg">

        {/* ── Welcome view ────────────────────────────────────────────────── */}
        {view === 'welcome' && (
          <div className="bg-white rounded-2xl shadow-lg p-8 space-y-6">
            <div className="text-center space-y-2">
              <div className="text-4xl mb-2">🎯</div>
              <h1 className="text-2xl font-bold text-gray-900">AI Screening Interview</h1>
              <p className="text-gray-500 text-sm">You've been invited to screen for:</p>
              <p className="text-lg font-semibold text-blue-700">{jdTitle}</p>
            </div>

            {/* What to expect — varies by mode */}
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-800 space-y-1.5">
              <p className="font-semibold mb-1">What to expect</p>
              <ul className="list-disc list-inside space-y-1 text-blue-700">
                <li>5 spoken interview questions — microphone required</li>
                <li>Speak your answers clearly when recording</li>
                <li>Takes about 10–15 minutes</li>
                <li>AI evaluates your responses immediately</li>
              </ul>
            </div>

            {/* Direct invite banner */}
            {interviewType === 'direct_invite' && (
              <div className="bg-teal-50 border border-teal-200 rounded-xl p-4 flex items-start gap-3">
                <span className="text-teal-600 text-lg leading-none mt-0.5">✓</span>
                <div>
                  <p className="text-sm font-semibold text-teal-800">
                    You have been personally invited for this role
                  </p>
                  <p className="text-xs text-teal-600 mt-1">
                    Your resume is already on file. Questions will be tailored to your background.
                  </p>
                </div>
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Full Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={candidateName}
                  onChange={interviewType === 'direct_invite'
                    ? undefined
                    : (e) => setCandidateName(e.target.value)}
                  readOnly={interviewType === 'direct_invite'}
                  placeholder="Your full name"
                  className={`w-full border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    interviewType === 'direct_invite'
                      ? 'border-gray-200 bg-gray-50 text-gray-500 cursor-not-allowed'
                      : 'border-gray-300'
                  }`}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Email <span className="text-red-500">*</span>
                </label>
                <input
                  type="email"
                  value={candidateEmail}
                  onChange={interviewType === 'direct_invite'
                    ? undefined
                    : (e) => setCandidateEmail(e.target.value)}
                  readOnly={interviewType === 'direct_invite'}
                  placeholder="your@email.com"
                  className={`w-full border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    interviewType === 'direct_invite'
                      ? 'border-gray-200 bg-gray-50 text-gray-500 cursor-not-allowed'
                      : 'border-gray-300'
                  }`}
                />
              </div>
              {/* Resume paste — only for legacy open links */}
              {interviewType === 'open_link' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Resume / Experience{' '}
                    <span className="text-gray-400 font-normal">(optional — improves question quality)</span>
                  </label>
                  <textarea
                    value={resumeText}
                    onChange={(e) => setResumeText(e.target.value)}
                    rows={4}
                    placeholder="Paste your resume text or briefly describe your background…"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
                  />
                </div>
              )}
            </div>

            {/* Integrity notice */}
            <div className="space-y-2">
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-800 text-sm">
                🔒 This screening includes integrity monitoring and requires agreement to
                our academic honesty policy before you can proceed.
              </div>
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-blue-800 text-sm">
                🎙 This screening uses voice-only mode. Please ensure your microphone is
                enabled in your browser.
              </div>
            </div>

            <button
              onClick={handleBeginClick}
              disabled={!candidateName.trim() || !candidateEmail.trim()}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white font-semibold py-3 rounded-xl text-sm transition-colors"
            >
              {interviewType === 'direct_invite' ? 'Begin My Interview →' : 'Begin Screening →'}
            </button>
          </div>
        )}

        {/* ── Interview view ───────────────────────────────────────────────── */}
        {view === 'interview' && (
          <div className="bg-white rounded-2xl shadow-lg p-8 space-y-6">
            {/* Header + progress bar */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="font-semibold text-gray-700 truncate max-w-[60%]">
                  {jdTitle}
                </span>
                <span className="text-gray-400 flex-shrink-0 ml-2">
                  {currentIndex + 1} / {totalQuestions}
                </span>
              </div>
              <div className="flex gap-1.5">
                {Array.from({ length: totalQuestions }).map((_, i) => (
                  <div
                    key={i}
                    className={`flex-1 h-1.5 rounded-full transition-colors duration-500 ${
                      i < currentIndex
                        ? 'bg-teal-500'
                        : i === currentIndex
                        ? 'bg-blue-500'
                        : 'bg-gray-200'
                    }`}
                  />
                ))}
              </div>
            </div>

            {/* Question block */}
            <div className="space-y-4">
              {isFollowup ? (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                  <p className="text-xs font-bold text-amber-600 mb-1.5 tracking-wide">
                    FOLLOW-UP QUESTION
                  </p>
                  <p className="text-gray-800 font-medium leading-relaxed">
                    {followupQuestion}
                  </p>
                </div>
              ) : (
                <div className="bg-gray-50 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-1.5">
                    <p className="text-xs font-bold text-gray-400 tracking-wide">
                      QUESTION {currentIndex + 1}
                    </p>
                    {currentQuestion?.probes_skill && (
                      <span className="text-xs bg-teal-50 text-teal-700 px-2 py-0.5 rounded-full font-medium">
                        {currentQuestion.probes_skill}
                      </span>
                    )}
                  </div>
                  <p className="text-gray-800 font-medium leading-relaxed text-base">
                    {currentQuestion?.question}
                  </p>
                </div>
              )}

              {/* ── Speech answer area ───────────────────────────────── */}
              <div className="space-y-4">
                <div className="flex flex-col items-center gap-3 py-2">
                  <button
                    onClick={isRecording ? stopRecording : startRecording}
                    className={`w-20 h-20 rounded-full flex items-center justify-center transition-all duration-200 shadow-lg ${
                      isRecording
                        ? 'bg-red-500 hover:bg-red-600 ring-4 ring-red-200 animate-pulse'
                        : 'bg-teal-600 hover:bg-teal-700 scale-100 hover:scale-105'
                    }`}
                  >
                    <span className="text-3xl">{isRecording ? '⏹' : '🎙'}</span>
                  </button>
                  <span className={`text-sm font-medium ${isRecording ? 'text-red-500 animate-pulse' : 'text-gray-500'}`}>
                    {isRecording ? '● Recording — tap to stop' : 'Tap to speak'}
                  </span>
                </div>
                {/* Read-only transcript display */}
                <div className="min-h-[7rem] border border-gray-200 bg-gray-50 rounded-xl px-4 py-3 text-sm text-gray-700 leading-relaxed">
                  {answer ? (
                    <p>{answer}</p>
                  ) : (
                    <p className="text-gray-400 italic">
                      Your speech will appear here as you speak…
                    </p>
                  )}
                </div>
              </div>

              {/* Stats row — duration, word count, filler count */}
              <div className="flex items-center gap-4 flex-wrap">
                {(isRecording || recordingDuration > 0) && (
                  <span className="text-xs text-gray-400">
                    ⏱ {Math.floor(recordingDuration / 60)}:{String(recordingDuration % 60).padStart(2, '0')}
                  </span>
                )}
                <span className={`text-xs ${wc < 10 ? 'text-red-400' : 'text-gray-400'}`}>
                  📝 {wc} word{wc !== 1 ? 's' : ''}{wc < 10 ? ' — min 10' : ''}
                </span>
                {answer && fillerCount > 0 && (
                  <span className="text-xs text-gray-400">
                    💬 {fillerCount} filler word{fillerCount !== 1 ? 's' : ''}
                  </span>
                )}
              </div>

              {answerError && <p className="text-sm text-red-600">{answerError}</p>}
            </div>

            <button
              onClick={handleSubmitAnswer}
              disabled={submitting || wc < 10 || isRecording}
              className="w-full bg-teal-600 hover:bg-teal-700 disabled:bg-gray-300 text-white font-semibold py-3 rounded-xl text-sm transition-colors flex items-center justify-center gap-2"
            >
              {submitting && (
                <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
              )}
              {submitting
                ? 'Evaluating…'
                : isRecording
                ? 'Stop recording first'
                : isFollowup
                ? 'Submit Follow-up'
                : currentIndex + 1 === totalQuestions
                ? 'Submit Final Answer'
                : 'Submit Answer →'}
            </button>
          </div>
        )}

        {/* ── Complete view ────────────────────────────────────────────────── */}
        {view === 'complete' && (
          <div className="bg-white rounded-2xl shadow-lg p-8 space-y-6 text-center">
            <div className="text-5xl">🎉</div>
            <div className="space-y-1">
              <h1 className="text-2xl font-bold text-gray-900">Screening Complete!</h1>
              <p className="text-gray-500 text-sm">
                You've finished the AI screening for
              </p>
              <p className="font-semibold text-blue-700">{jdTitle}</p>
            </div>

            <div className="flex justify-center">
              <div
                className={`w-24 h-24 rounded-2xl border-2 flex items-center justify-center ${
                  GRADE_STYLES[finalGrade] || GRADE_STYLES.F
                }`}
              >
                <span className="text-5xl font-bold leading-none">{finalGrade || 'C'}</span>
              </div>
            </div>

            <div className="space-y-0.5">
              <p className="text-3xl font-bold text-gray-900">{finalScore}/100</p>
              <p className="text-sm text-gray-400">Overall Score</p>
            </div>

            {headline && (
              <div className="bg-gray-50 rounded-xl p-4">
                <p className="text-sm text-gray-600 italic">"{headline}"</p>
              </div>
            )}

            <div className="bg-green-50 border border-green-200 rounded-xl p-4">
              <p className="text-sm text-green-800">
                ✅ Your results have been submitted to the recruiter. They'll reach out
                if you're shortlisted — good luck!
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
