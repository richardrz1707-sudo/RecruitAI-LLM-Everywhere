import { useState, useEffect, useRef } from "react"
import { sendChatMessage, getChatHistory, clearChatHistory, getDecisionLog, getSecurityLog, getConversations } from "../lib/api"

// ── TOOL LABELS ────────────────────────────────────────────────────
const TOOL_LABELS = {
  create_jd:       { label: "Posted JD",          icon: "📋", color: "bg-teal-50 text-teal-700 border-teal-200" },
  run_matching:    { label: "Ran matching",        icon: "🔍", color: "bg-blue-50 text-blue-700 border-blue-200" },
  send_invite:     { label: "Sent invite",         icon: "✉️",  color: "bg-purple-50 text-purple-700 border-purple-200" },
  get_results:     { label: "Fetched results",     icon: "📊", color: "bg-amber-50 text-amber-700 border-amber-200" },
  get_candidates:  { label: "Fetched candidates",  icon: "👥", color: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  get_jd_list:     { label: "Fetched JD list",     icon: "📁", color: "bg-gray-100 text-gray-600 border-gray-200" },
  guardrail_agent: { label: "Blocked by security", icon: "🛡️", color: "bg-red-50 text-red-700 border-red-200" },
}

// ── SUGGESTED STARTER MESSAGES ──────────────────────────────────────
const SUGGESTIONS = [
  "Post a new job",
  "Find candidates for my latest JD",
  "Check screening results",
  "Invite a candidate to screen",
  "Show me my job listings",
]

// ── CONVERSATION ID ─────────────────────────────────────────────────
// Generated once per browser session — persists across component remounts
const getConversationId = () => {
  let id = sessionStorage.getItem("recruitai_chat_id")
  if (!id) {
    id = `chat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    sessionStorage.setItem("recruitai_chat_id", id)
  }
  return id
}

// ── MARKDOWN HELPER ──────────────────────────────────────────────
const renderMarkdown = (text) => {
  if (!text) return ""
  return text
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br/>")
}

// ── MAIN COMPONENT ──────────────────────────────────────────────────
export default function ChatAgent() {
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [conversationId, setConversationId] = useState(getConversationId)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)
  const [activeTab, setActiveTab] = useState("chat")
  const [decisions, setDecisions] = useState([])
  const [securityViolations, setSecurityViolations] = useState([])
  const [thinkingStatus, setThinkingStatus] = useState("thinking")
  const [showSlowMessage, setShowSlowMessage] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [conversations, setConversations] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)
  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)

  // Auto-scroll to latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, isLoading])

  // Focus input and clear unread count on open
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100)
      setUnreadCount(0)
    }
  }, [isOpen])

  // Load history on first open
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
          action_taken: h.action_taken,
          blocked: h.tool_used === "guardrail_agent",
        })))
      }
    } catch {
      // History load failed silently — start fresh
    }
  }

  const loadDecisionLog = async () => {
    try {
      const [logRes, secRes] = await Promise.all([
        getDecisionLog(conversationId),
        getSecurityLog()
      ])
      setDecisions(logRes.data.decisions || [])
      setSecurityViolations(secRes.data.violations || [])
    } catch {
      // Decision log load failed silently
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
    localStorage.setItem("recruitai_chat_id", convId)
    setConversationId(convId)
    setShowHistory(false)
    setActiveTab("chat")
    try {
      const res = await getChatHistory(convId)
      const history = res.data.history || []
      setMessages(history.map(h => ({
        role: h.role,
        content: h.content,
        tool_used: h.tool_used || null,
        action_taken: h.action_taken || null,
        blocked: h.tool_used === "guardrail_agent",
        violation_type: h.tool_used === "guardrail_agent"
          ? h.action_taken?.replace("Blocked — ", "")
          : null,
        fromHistory: true
      })))
      setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
      }, 100)
    } catch (err) {
      setMessages([])
      console.log("Could not load conversation:", err)
    }
  }

  const startNewConversation = () => {
    const newId = `chat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    localStorage.setItem("recruitai_chat_id", newId)
    setConversationId(newId)
    setMessages([])
    setShowHistory(false)
    setActiveTab("chat")
  }

  // ── SEND MESSAGE ─────────────────────────────────────────────────
  const handleSend = async (messageText = input) => {
    const text = messageText.trim()
    if (!text || isLoading) return

    setMessages(prev => [...prev, { role: "user", content: text }])
    setInput("")
    setIsLoading(true)

    // FIX 3: contextual thinking status
    const msgLower = text.toLowerCase()
    if (msgLower.includes("find") || msgLower.includes("match") || msgLower.includes("candidates")) {
      setThinkingStatus("matching")
    } else if (msgLower.includes("post") || msgLower.includes("create") || msgLower.includes("job")) {
      setThinkingStatus("posting")
    } else if (msgLower.includes("invite") || msgLower.includes("screen")) {
      setThinkingStatus("inviting")
    } else if (msgLower.includes("show") || msgLower.includes("list") || msgLower.includes("result")) {
      setThinkingStatus("loading")
    } else {
      setThinkingStatus("thinking")
    }

    // FIX 6: slow-message timer
    const slowTimer = setTimeout(() => setShowSlowMessage(true), 8000)

    try {
      const res = await sendChatMessage(text, conversationId)
      console.log('API response:', res)
      console.log('API response data:', res.data)
      console.log('Reply text:', res.data?.reply)
      const data = res.data

      const assistantMsg = {
        role: "assistant",
        content: data.reply || data.message || data.text || "Action completed.",
        tool_used: data.tool_used,
        action_taken: data.action_taken,
        agent_reasoning: data.agent_reasoning,
        blocked: data.blocked || false,
        violation_type: data.violation_type,
      }
      console.log('Assistant message:', assistantMsg)
      console.log('Content:', assistantMsg.content)

      setMessages(prev => [...prev, assistantMsg])

      if (!isOpen) setUnreadCount(prev => prev + 1)
      loadDecisionLog()

    } catch {
      setMessages(prev => [...prev, {
        role: "assistant",
        content: "Sorry, something went wrong. Please try again.",
        tool_used: null,
        blocked: false,
      }])
    } finally {
      setIsLoading(false)
      setShowSlowMessage(false)   // FIX 6
      clearTimeout(slowTimer)     // FIX 6
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleClear = async () => {
    try {
      await clearChatHistory(conversationId)
      sessionStorage.removeItem("recruitai_chat_id")
    } catch { /* silent */ }
    setMessages([])
    setHasLoaded(false)
  }

  // ── RENDER MESSAGE BUBBLE ────────────────────────────────────────
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
            {/* Avatar */}
            <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5 ${
              isBlocked ? "bg-red-500 text-white" : "bg-teal-600 text-white"
            }`}>
              {isBlocked ? "🛡" : "AI"}
            </div>

            <div className="flex-1 min-w-0">
              {/* Message bubble */}
              <div
                className={`text-sm px-4 py-2.5 rounded-2xl rounded-tl-sm leading-relaxed ${
                  isBlocked
                    ? "bg-red-50 text-red-800 border border-red-200"
                    : "bg-gray-100 text-gray-800"
                }`}
                dangerouslySetInnerHTML={{
                  __html: renderMarkdown(
                    msg.content || msg.text || msg.message || "..."
                  )
                }}
              />

              {/* Tool badge — normal reply */}
              {toolInfo && !isBlocked && (
                <div className={`inline-flex items-center gap-1 mt-1.5 text-xs px-2 py-0.5 rounded-full border ${toolInfo.color}`}>
                  <span>{toolInfo.icon}</span>
                  <span>{toolInfo.label}</span>
                </div>
              )}

              {/* FIX 5: completion timestamp */}
              {!isBlocked && (
                <p className="text-xs text-gray-300 mt-1 ml-1">
                  ✓ {new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </p>
              )}

              {/* Security block panel */}
              {isBlocked && (
                <div className="mt-1.5 bg-red-50 border border-red-200 rounded-lg p-2">
                  <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                    <span className="text-xs font-medium text-red-700">🛡️ Security Agent</span>
                    {msg.violation_type && (
                      <span className="text-xs bg-red-100 text-red-600 px-1.5 py-0.5 rounded uppercase tracking-wide font-medium">
                        {msg.violation_type.replace(/_/g, " ")}
                      </span>
                    )}
                  </div>
                  {msg.agent_reasoning && (
                    <p className="text-xs text-red-600 leading-relaxed italic">
                      "{msg.agent_reasoning}"
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── TYPING INDICATOR ─────────────────────────────────────────────
  const TypingIndicator = ({ status }) => {
    const statusMessages = {
      thinking:  "Agent is thinking...",
      searching: "Searching candidates...",
      matching:  "Running AI matching...",
      posting:   "Posting job...",
      inviting:  "Sending invite...",
      loading:   "Loading results...",
    }
    const label = statusMessages[status] || "Agent is thinking..."
    return (
      <div className="flex justify-start mb-3">
        <div className="flex items-start gap-2">
          <div className="w-7 h-7 rounded-full bg-teal-600 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
            AI
          </div>
          <div className="bg-gray-100 px-4 py-3 rounded-2xl rounded-tl-sm">
            <div className="flex items-center gap-2">
              <div className="flex gap-1">
                <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
              <span className="text-xs text-gray-400 italic">{label}</span>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── WELCOME MESSAGE ───────────────────────────────────────────────
  const WelcomeMessage = () => (
    <div className="flex justify-start mb-4">
      <div className="flex items-start gap-2 max-w-[85%]">
        <div className="w-7 h-7 rounded-full bg-teal-600 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
          AI
        </div>
        <div>
          <div className="bg-gray-100 text-gray-800 text-sm px-4 py-2.5 rounded-2xl rounded-tl-sm leading-relaxed">
            Hi! I'm your RecruitAI assistant. I can help you post jobs, find candidates, send interview invitations, and check results. What would you like to do?
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

  // ── MAIN RENDER ───────────────────────────────────────────────────
  return (
    <>
      {/* ── FLOATING BUTTON ─────────────────────────────────────── */}
      <button
        onClick={() => setIsOpen(prev => !prev)}
        className={`fixed bottom-6 right-6 z-40 w-14 h-14 rounded-full shadow-lg flex items-center justify-center transition-all duration-300 ${
          isOpen ? "bg-gray-700 hover:bg-gray-800" : "bg-teal-600 hover:bg-teal-700"
        }`}
        aria-label="Open AI assistant"
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

        {/* Unread badge */}
        {!isOpen && unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center font-medium">
            {unreadCount}
          </span>
        )}
      </button>

      {/* ── CHAT PANEL ──────────────────────────────────────────── */}
      {isOpen && (
        <div
          className="fixed z-40 bg-white rounded-2xl shadow-2xl border border-gray-200 overflow-hidden transition-all duration-300 ease-in-out"
          style={{
            width: isMaximized ? "480px" : "320px",
            height: isMaximized ? "640px" : "480px",
            bottom: "96px",
            right: "24px"
          }}
        >
          {/* Inner wrapper — relative so history sidebar positions correctly */}
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
              <span className="text-white font-medium text-sm">RecruitAI Assistant</span>
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
                      const isActive = conv.conversation_id === localStorage.getItem("recruitai_chat_id")
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

          {/* Tab headers */}
          <div className="flex border-b border-gray-100 flex-shrink-0">
            <button
              onClick={() => setActiveTab("chat")}
              className={`flex-1 py-2 text-xs font-medium transition-colors ${
                activeTab === "chat"
                  ? "text-teal-600 border-b-2 border-teal-600"
                  : "text-gray-400 hover:text-gray-600"
              }`}
            >
              💬 Chat
            </button>
            <button
              onClick={() => { setActiveTab("log"); loadDecisionLog() }}
              className={`flex-1 py-2 text-xs font-medium transition-colors ${
                activeTab === "log"
                  ? "text-teal-600 border-b-2 border-teal-600"
                  : "text-gray-400 hover:text-gray-600"
              }`}
            >
              🤖 Agent Log
              {decisions.length > 0 && (
                <span className="ml-1 bg-teal-100 text-teal-700 text-xs px-1.5 rounded-full">
                  {decisions.length}
                </span>
              )}
            </button>
            <button
              onClick={() => { setActiveTab("security"); loadDecisionLog() }}
              className={`flex-1 py-2 text-xs font-medium transition-colors ${
                activeTab === "security"
                  ? "text-red-600 border-b-2 border-red-600"
                  : "text-gray-400 hover:text-gray-600"
              }`}
            >
              🛡️ Security
              {securityViolations.length > 0 && (
                <span className="ml-1 bg-red-100 text-red-600 text-xs px-1.5 rounded-full">
                  {securityViolations.length}
                </span>
              )}
            </button>
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto px-3 py-3">

            {/* CHAT TAB */}
            {activeTab === "chat" && (
              <>
                {messages.length === 0 && <WelcomeMessage />}
                {messages.map((msg, i) => renderMessage(msg, i))}
                {isLoading && <TypingIndicator status={thinkingStatus} />}
                {isLoading && showSlowMessage && (
                  <div className="flex justify-start mb-2 ml-9">
                    <p className="text-xs text-gray-400 italic">
                      This is taking a moment — AI matching can take up to 15 seconds...
                    </p>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </>
            )}

            {/* AGENT LOG TAB */}
            {activeTab === "log" && (
              <div>
                <div className="mb-3">
                  <p className="text-xs font-medium text-gray-700 mb-1">
                    🤖 Dynamic Decision Making — Pillar 1
                  </p>
                  <p className="text-xs text-gray-400 leading-relaxed">
                    Every entry below shows a decision Claude made autonomously — which tool to invoke and why. Python only executes. Claude decides.
                  </p>
                </div>
                {decisions.length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-xs text-gray-400">
                      No tool decisions yet. Send a message to see the agent reasoning log.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {decisions.map((d, i) => {
                      const toolInfo = TOOL_LABELS[d.tool]
                      const isBlocked = d.is_blocked
                      return (
                        <div
                          key={i}
                          className={`rounded-lg border p-3 ${
                            isBlocked ? "bg-red-50 border-red-200" : "bg-gray-50 border-gray-200"
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <div className="flex items-center gap-1.5">
                              <span className="text-sm">{toolInfo?.icon || "🔧"}</span>
                              <span className={`text-xs font-medium ${isBlocked ? "text-red-700" : "text-gray-700"}`}>
                                {d.tool}
                              </span>
                            </div>
                            <span className="text-xs text-gray-400">
                              {new Date(d.timestamp).toLocaleTimeString()}
                            </span>
                          </div>
                          {d.action && (
                            <p className="text-xs text-gray-500 leading-relaxed mt-1">
                              {d.action.length > 120 ? d.action.substring(0, 120) + "…" : d.action}
                            </p>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {/* SECURITY TAB */}
            {activeTab === "security" && (
              <div>
                <div className="mb-3">
                  <p className="text-xs font-medium text-gray-700 mb-1">
                    🛡️ Guardrail Activity — Pillar 2
                  </p>
                  <p className="text-xs text-gray-400 leading-relaxed">
                    Messages blocked by the 3-layer security system. Layer 1: Python fast check. Layer 2: Guard Agent (Claude Haiku). Layer 3: Main Agent never sees blocked messages.
                  </p>
                </div>
                {securityViolations.length === 0 ? (
                  <div className="text-center py-8">
                    <div className="text-2xl mb-2">✅</div>
                    <p className="text-xs text-gray-400">No violations detected. System is clean.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {securityViolations.map((v, i) => (
                      <div key={i} className="bg-red-50 border border-red-200 rounded-lg p-3">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-medium text-red-700 uppercase tracking-wide">
                            {v.violation_type?.replace(/_/g, " ")}
                          </span>
                          <span className="text-xs text-gray-400">
                            {new Date(v.created_at).toLocaleTimeString()}
                          </span>
                        </div>
                        <p className="text-xs text-red-600 mb-1 font-mono bg-red-100 px-2 py-1 rounded truncate">
                          "{v.message?.substring(0, 60)}{v.message?.length > 60 ? "…" : ""}"
                        </p>
                        {v.reason && (
                          <p className="text-xs text-gray-500 italic">{v.reason}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

          </div>

          {/* Input area — only shown on chat tab */}
          {activeTab === "chat" && <div className="border-t border-gray-100 px-3 py-2.5 flex-shrink-0">
            <div className="flex gap-2 items-end">
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type a message..."
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
          </div>}
          </div>{/* end relative inner wrapper */}
        </div>
      )}
    </>
  )
}
