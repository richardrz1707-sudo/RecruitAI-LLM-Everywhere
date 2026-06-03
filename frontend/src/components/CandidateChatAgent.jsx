import { useState, useEffect, useRef } from "react"
import { sendCandidateChatMessage, getChatHistory, getConversations } from "../lib/api"

// ── TOOL LABELS ────────────────────────────────────────────────────
const TOOL_LABELS = {
  get_my_invites:      { label: "Fetched invites",       icon: "✉️",  color: "bg-purple-50 text-purple-700 border-purple-200" },
  get_my_applications: { label: "Fetched applications",  icon: "📝", color: "bg-blue-50 text-blue-700 border-blue-200" },
  get_my_feedback:     { label: "Fetched feedback",      icon: "💬", color: "bg-teal-50 text-teal-700 border-teal-200" },
  get_open_jobs:       { label: "Browsed jobs",          icon: "🔍", color: "bg-amber-50 text-amber-700 border-amber-200" },
  get_resume_score:    { label: "Checked resume",        icon: "📄", color: "bg-green-50 text-green-700 border-green-200" },
  find_matching_jobs:  { label: "Found matching jobs",   icon: "🔍", color: "bg-blue-50 text-blue-700 border-blue-200" },
  bulk_apply:          { label: "Applied to roles",      icon: "🚀", color: "bg-teal-50 text-teal-700 border-teal-200" },
  guardrail_agent:     { label: "Blocked by security",   icon: "🛡️", color: "bg-red-50 text-red-700 border-red-200" },
}

const SUGGESTIONS = [
  "Show my invites",
  "Check my applications",
  "Browse open jobs",
  "Show my feedback",
  "Check my resume score",
  "Apply to mechanical engineering roles",
  "Find data analyst jobs",
]

// ── MARKDOWN HELPER ──────────────────────────────────────────────
const renderMarkdown = (text) => {
  if (!text) return ""
  return text
    .replace(/\[JD_IDS:[^\]]*\]/g, "")   // strip hidden ID tag — stays in DB for Claude
    .trim()
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br/>")
}

// ── CONVERSATION ID ─────────────────────────────────────────────
const STORAGE_KEY = "recruitai_candidate_chat_id"

const getConversationId = () => {
  let id = localStorage.getItem(STORAGE_KEY)
  if (!id) {
    id = `cand_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    localStorage.setItem(STORAGE_KEY, id)
  }
  return id
}

// ── MAIN COMPONENT ──────────────────────────────────────────────
export default function CandidateChatAgent() {
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [conversationId, setConversationId] = useState(getConversationId)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)
  const [thinkingStatus, setThinkingStatus] = useState("thinking")
  const [showSlowMessage, setShowSlowMessage] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [conversations, setConversations] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)
  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, isLoading])

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100)
      setUnreadCount(0)
    }
  }, [isOpen])

  useEffect(() => {
    if (isOpen && !hasLoaded) {
      loadHistory()
      setHasLoaded(true)
    }
  }, [isOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadHistory = async () => {
    try {
      const res = await getChatHistory(conversationId)
      const history = res.data.history || []
      if (history.length > 0) {
        setMessages(history.map(h => ({
          role: h.role,
          content: h.content,
          tool_used: h.tool_used,
          blocked: h.tool_used === "guardrail_agent",
        })))
      }
    } catch {
      // silent
    }
  }

  const loadConversations = async () => {
    setHistoryLoading(true)
    try {
      const res = await getConversations()
      setConversations(res.data.conversations || [])
    } catch {
      console.log("Could not load conversations")
    } finally {
      setHistoryLoading(false)
    }
  }

  const switchConversation = async (convId) => {
    localStorage.setItem(STORAGE_KEY, convId)
    setConversationId(convId)
    setShowHistory(false)
    setHasLoaded(false)
    try {
      const res = await getChatHistory(convId)
      const history = res.data.history || []
      setMessages(history.map(h => ({
        role: h.role,
        content: h.content,
        tool_used: h.tool_used || null,
        blocked: h.tool_used === "guardrail_agent",
        violation_type: h.tool_used === "guardrail_agent"
          ? h.action_taken?.replace("Blocked — ", "")
          : null,
        fromHistory: true
      })))
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100)
    } catch (err) {
      setMessages([])
      console.log("Could not load conversation:", err)
    }
  }

  const startNewConversation = () => {
    const newId = `cand_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    localStorage.setItem(STORAGE_KEY, newId)
    setConversationId(newId)
    setMessages([])
    setShowHistory(false)
  }

  // ── SEND MESSAGE ─────────────────────────────────────────────
  const handleSend = async (messageText = input) => {
    const text = messageText.trim()
    if (!text || isLoading) return

    setMessages(prev => [...prev, { role: "user", content: text }])
    setInput("")
    setIsLoading(true)

    const msgLower = text.toLowerCase()
    if (msgLower.includes("invite") || msgLower.includes("interview") || msgLower.includes("screen")) {
      setThinkingStatus("searching")
    } else if (msgLower.includes("appl") || msgLower.includes("status")) {
      setThinkingStatus("loading")
    } else if (msgLower.includes("job") || msgLower.includes("role") || msgLower.includes("browse")) {
      setThinkingStatus("searching")
    } else if (msgLower.includes("feedback") || msgLower.includes("result")) {
      setThinkingStatus("loading")
    } else if (msgLower.includes("resume") || msgLower.includes("score")) {
      setThinkingStatus("loading")
    } else {
      setThinkingStatus("thinking")
    }

    const slowTimer = setTimeout(() => setShowSlowMessage(true), 8000)

    try {
      const res = await sendCandidateChatMessage(text, conversationId)
      console.log("[CandidateChat] response:", res.data)
      const data = res.data

      const assistantMsg = {
        role: "assistant",
        content: data.reply || data.message || "Action completed.",
        tool_used: data.tool_used,
        blocked: data.blocked || false,
        violation_type: data.violation_type,
        agent_reasoning: data.agent_reasoning,
      }
      setMessages(prev => [...prev, assistantMsg])
      if (!isOpen) setUnreadCount(prev => prev + 1)

    } catch (err) {
      console.error("[CandidateChat] error:", err)
      setMessages(prev => [...prev, {
        role: "assistant",
        content: "Sorry, something went wrong. Please try again.",
        tool_used: null,
        blocked: false,
      }])
    } finally {
      setIsLoading(false)
      setShowSlowMessage(false)
      clearTimeout(slowTimer)
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // ── RENDER MESSAGE BUBBLE ────────────────────────────────────
  const renderMessage = (msg, index) => {
    const isUser = msg.role === "user"
    const toolInfo = msg.tool_used ? TOOL_LABELS[msg.tool_used] : null
    const isBlocked = msg.blocked

    if (isUser) {
      return (
        <div key={index} className="flex justify-end mb-3">
          <div className="max-w-[85%]">
            <div className="bg-teal-600 text-white text-sm px-4 py-2.5 rounded-2xl rounded-tr-sm leading-relaxed">
              {msg.content}
            </div>
          </div>
        </div>
      )
    }

    return (
      <div key={index} className="flex justify-start mb-3">
        <div className="max-w-[85%] w-full">
          <div className="flex items-start gap-2">
            <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5 ${
              isBlocked ? "bg-red-500 text-white" : "bg-teal-600 text-white"
            }`}>
              {isBlocked ? "🛡" : "AI"}
            </div>
            <div className="flex-1 min-w-0">
              <div
                className={`text-sm px-4 py-2.5 rounded-2xl rounded-tl-sm leading-relaxed ${
                  isBlocked ? "bg-red-50 text-red-800 border border-red-200" : "bg-gray-100 text-gray-800"
                }`}
                dangerouslySetInnerHTML={{
                  __html: renderMarkdown(msg.content || msg.text || "...")
                }}
              />
              {toolInfo && !isBlocked && (
                <div className={`inline-flex items-center gap-1 mt-1.5 text-xs px-2 py-0.5 rounded-full border ${toolInfo.color}`}>
                  <span>{toolInfo.icon}</span>
                  <span>{toolInfo.label}</span>
                </div>
              )}
              {msg.tool_used === "bulk_apply" && msg.content && (
                <div className="mt-2 bg-teal-50 border border-teal-200 rounded-lg p-3">
                  <p className="text-xs font-medium text-teal-700 mb-1">🚀 Bulk application complete</p>
                  <p className="text-xs text-teal-600">Applications submitted and visible to recruiters</p>
                </div>
              )}
              {isBlocked && (
                <div className="mt-1.5 bg-red-50 border border-red-200 rounded-lg p-2">
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="text-xs font-medium text-red-700">🛡️ Security Agent</span>
                    {msg.violation_type && (
                      <span className="text-xs bg-red-100 text-red-600 px-1.5 py-0.5 rounded uppercase tracking-wide font-medium">
                        {msg.violation_type.replace(/_/g, " ")}
                      </span>
                    )}
                  </div>
                  {msg.agent_reasoning && (
                    <p className="text-xs text-red-600 italic">"{msg.agent_reasoning}"</p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── TYPING INDICATOR ─────────────────────────────────────────
  const statusMessages = {
    thinking:  "Assistant is thinking...",
    searching: "Searching...",
    loading:   "Loading your data...",
  }
  const TypingIndicator = () => (
    <div className="flex justify-start mb-3">
      <div className="flex items-start gap-2">
        <div className="w-7 h-7 rounded-full bg-teal-600 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">AI</div>
        <div className="bg-gray-100 px-4 py-3 rounded-2xl rounded-tl-sm">
          <div className="flex items-center gap-2">
            <div className="flex gap-1">
              <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
              <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
              <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
            </div>
            <span className="text-xs text-gray-400 italic">{statusMessages[thinkingStatus] || "Thinking..."}</span>
          </div>
        </div>
      </div>
    </div>
  )

  // ── WELCOME MESSAGE ───────────────────────────────────────────
  const WelcomeMessage = () => (
    <div className="flex justify-start mb-4">
      <div className="flex items-start gap-2 max-w-[85%]">
        <div className="w-7 h-7 rounded-full bg-teal-600 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">AI</div>
        <div>
          <div className="bg-gray-100 text-gray-800 text-sm px-4 py-2.5 rounded-2xl rounded-tl-sm leading-relaxed">
            Hi! I'm your career assistant. I can show your invites, applications, feedback, open jobs, and resume scores. What would you like to check?
          </div>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {SUGGESTIONS.map((s, i) => (
              <button
                key={i}
                onClick={() => handleSend(s)}
                className="text-xs bg-white border border-gray-200 text-gray-600 px-2.5 py-1 rounded-full hover:bg-teal-50 hover:border-teal-300 hover:text-teal-700 transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )

  // ── MAIN RENDER ───────────────────────────────────────────────
  return (
    <>
      {/* Floating button */}
      <button
        onClick={() => setIsOpen(prev => !prev)}
        className={`fixed bottom-6 right-6 z-40 w-14 h-14 rounded-full shadow-lg flex items-center justify-center transition-all duration-300 ${
          isOpen ? "bg-gray-700 hover:bg-gray-800" : "bg-teal-600 hover:bg-teal-700"
        }`}
        aria-label="Open career assistant"
      >
        {isOpen ? (
          <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : (
          <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
          </svg>
        )}
        {!isOpen && unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center font-medium">
            {unreadCount}
          </span>
        )}
      </button>

      {/* Chat panel */}
      {isOpen && (
        <div
          className="fixed z-40 bg-white rounded-2xl shadow-2xl border border-gray-200 overflow-hidden transition-all duration-300 ease-in-out"
          style={{
            width: isMaximized ? "480px" : "320px",
            height: isMaximized ? "640px" : "460px",
            bottom: "96px",
            right: "24px"
          }}
        >
          <div className="relative flex flex-col h-full">

            {/* Header */}
            <div className="bg-teal-600 px-4 py-3 flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { setShowHistory(prev => !prev); if (!showHistory) loadConversations() }}
                  className="text-teal-200 hover:text-white transition-colors"
                  title="Chat history"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h7" />
                  </svg>
                </button>
                <div className="w-2 h-2 bg-teal-300 rounded-full animate-pulse" />
                <span className="text-white font-medium text-sm">RecruitAI Career Assistant</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setIsMaximized(prev => !prev)}
                  className="text-teal-200 hover:text-white transition-colors"
                  title={isMaximized ? "Minimize" : "Maximize"}
                >
                  {isMaximized ? (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 9L4 4m0 0h5m-5 0v5M15 9l5-5m0 0h-5m5 0v5M9 15l-5 5m0 0h5m-5 0v-5M15 15l5 5m0 0h-5m5 0v-5"/>
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/>
                    </svg>
                  )}
                </button>
                <button
                  onClick={startNewConversation}
                  className="text-teal-200 hover:text-white text-xs transition-colors flex items-center gap-1"
                  title="New conversation"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                  New
                </button>
              </div>
            </div>

            {/* History sidebar — slides in over the chat */}
            {showHistory && (
              <div className="absolute inset-0 bg-white z-10 flex flex-col" style={{ top: "52px" }}>
                <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
                  <span className="text-sm font-medium text-gray-700">Chat history</span>
                  <button onClick={() => setShowHistory(false)} className="text-gray-400 hover:text-gray-600 text-xs">
                    ✕ Close
                  </button>
                </div>
                <div className="px-3 py-2 border-b border-gray-100 flex-shrink-0">
                  <button
                    onClick={startNewConversation}
                    className="w-full flex items-center gap-2 px-3 py-2 bg-teal-50 hover:bg-teal-100 text-teal-700 text-xs font-medium rounded-lg transition-colors"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                    </svg>
                    Start new conversation
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto">
                  {historyLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <div className="w-5 h-5 border-2 border-teal-600 border-t-transparent rounded-full animate-spin" />
                    </div>
                  ) : conversations.length === 0 ? (
                    <div className="text-center py-8 px-4">
                      <p className="text-xs text-gray-400">No past conversations yet.</p>
                    </div>
                  ) : (
                    <div className="py-1">
                      {conversations.map((conv, i) => {
                        const isActive = conv.conversation_id === localStorage.getItem(STORAGE_KEY)
                        return (
                          <button
                            key={i}
                            onClick={() => switchConversation(conv.conversation_id)}
                            className={`w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors border-b border-gray-50 ${
                              isActive ? "bg-teal-50 border-l-2 border-l-teal-500" : ""
                            }`}
                          >
                            <p className={`text-xs leading-relaxed line-clamp-2 ${isActive ? "text-teal-700 font-medium" : "text-gray-600"}`}>
                              {conv.title}
                            </p>
                            <p className="text-xs text-gray-400 mt-1">
                              {new Date(conv.last_active).toLocaleDateString([], {
                                month: "short", day: "numeric",
                                hour: "2-digit", minute: "2-digit"
                              })}
                            </p>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-3 py-3">
              {messages.length === 0 && <WelcomeMessage />}
              {messages.map((msg, i) => renderMessage(msg, i))}
              {isLoading && <TypingIndicator />}
              {isLoading && showSlowMessage && (
                <div className="flex justify-start mb-2 ml-9">
                  <p className="text-xs text-gray-400 italic">
                    This is taking a moment, please wait...
                  </p>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="border-t border-gray-100 px-3 py-2.5 flex-shrink-0">
              <div className="flex gap-2 items-end">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask about your invites, jobs..."
                  rows={1}
                  className="flex-1 text-sm border border-gray-200 rounded-xl px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent leading-relaxed"
                  style={{ maxHeight: "80px" }}
                  disabled={isLoading}
                />
                <button
                  onClick={() => handleSend()}
                  disabled={!input.trim() || isLoading}
                  className="w-9 h-9 bg-teal-600 hover:bg-teal-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl flex items-center justify-center flex-shrink-0 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                  </svg>
                </button>
              </div>
              <p className="text-xs text-gray-400 mt-1.5 text-center">
                Press Enter to send · Shift+Enter for new line
              </p>
            </div>

          </div>
        </div>
      )}
    </>
  )
}
