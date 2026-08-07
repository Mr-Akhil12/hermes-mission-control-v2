"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  Send, Mic, MicOff, Volume2, Loader2, MessageSquare, Plus, ChevronLeft, ChevronRight, Brain,
} from "lucide-react";

type ChatMsg = { role: "user" | "assistant"; content: string; reasoning?: string | null };
type SessionMeta = { id: string; title?: string | null; message_count?: number; last_message?: string | null };

export default function ChatPage() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [thinking, setThinking] = useState<string>("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const streamAbort = useRef<AbortController | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/sessions", { cache: "no-store" });
      const data = await res.json();
      const list: SessionMeta[] = data?.data ?? data?.sessions ?? [];
      setSessions(list);
      return list;
    } catch (e) {
      setError(`Failed to load conversations: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }, []);

  const loadMessages = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/chat/sessions/${id}/messages`, { cache: "no-store" });
      const data = await res.json();
      const list = data?.data ?? [];
      const msgs: ChatMsg[] = list
        .filter((m: any) => m.role === "user" || m.role === "assistant")
        .map((m: any) => ({
          role: m.role,
          content: m.content ?? "",
          reasoning: m.reasoning_content ?? m.reasoning ?? null,
        }));
      setMessages(msgs);
    } catch (e) {
      setError(`Failed to load messages: ${e instanceof Error ? e.message : e}`);
    }
  }, []);

  useEffect(() => {
    loadSessions().then((list) => {
      if (list.length > 0) {
        setActiveId(list[0].id);
        loadMessages(list[0].id);
      }
    });
  }, [loadSessions, loadMessages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy, thinking]);

  const newConversation = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      const id = data?.session?.id ?? data?.session_id;
      if (!id) throw new Error("No session id returned");
      setActiveId(id);
      setMessages([]);
      setThinking("");
      await loadSessions();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [loadSessions]);

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy || !activeId) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", content: trimmed }]);
    setBusy(true);
    setError(null);
    setThinking("");

    const abort = new AbortController();
    streamAbort.current = abort;

    try {
      const res = await fetch(`/api/chat/sessions/${activeId}/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, model: "deepseek-v4-flash:0731" }),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Chat failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let full = "";
      let reasoning = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by \n\n
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const lines = frame.split("\n");
          const eventLine = lines.find((l) => l.startsWith("event:"));
          const dataLine = lines.find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const event = eventLine?.slice(6).trim() ?? "message";
          const payload = JSON.parse(dataLine.slice(5).trim());

          if (event === "assistant.delta") {
            const delta = payload.delta ?? "";
            full += delta;
            setMessages((m) => {
              const copy = [...m];
              const last = copy[copy.length - 1];
              if (last?.role === "assistant") {
                copy[copy.length - 1] = { ...last, content: last.content + delta };
              } else {
                copy.push({ role: "assistant", content: delta });
              }
              return copy;
            });
          } else if (event === "tool.progress" && payload.tool_name === "_thinking") {
            const delta = payload.delta ?? "";
            reasoning += delta;
            setThinking(reasoning);
          } else if (event === "assistant.completed") {
            if (payload.content) {
              setMessages((m) => {
                const copy = [...m];
                const last = copy[copy.length - 1];
                if (last?.role === "assistant") {
                  copy[copy.length - 1] = { ...last, content: payload.content, reasoning: reasoning || null };
                } else {
                  copy.push({ role: "assistant", content: payload.content, reasoning: reasoning || null });
                }
                return copy;
              });
            }
            setThinking("");
          } else if (event === "error") {
            throw new Error(payload?.error ?? "Stream error");
          }
        }
      }

      if (voiceOn && full) {
        try {
          const synth = window.speechSynthesis;
          const utter = new SpeechSynthesisUtterance(full.replace(/[#*`>]/g, "").slice(0, 400));
          synth.speak(utter);
        } catch { /* TTS unavailable */ }
      }
      await loadSessions();
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
      setThinking("");
      streamAbort.current = null;
    }
  }, [busy, activeId, voiceOn, loadSessions]);

  const toggleMic = useCallback(() => {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setError("Speech recognition not supported in this browser. Use Chrome or Safari.");
      return;
    }
    const rec = new SR();
    rec.lang = "en-ZA";
    rec.interimResults = false;
    rec.onresult = (e: any) => {
      const text = e.results?.[0]?.[0]?.transcript ?? "";
      setInput(text);
      if (text.trim()) send(text);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
    rec.start();
    setListening(true);
    setError(null);
  }, [listening, send]);

  const selectSession = useCallback((id: string) => {
    setActiveId(id);
    setMessages([]);
    setThinking("");
    loadMessages(id);
  }, [loadMessages]);

  return (
    <div className="mx-auto flex h-[calc(100vh-170px)] min-h-[480px] max-w-5xl flex-col">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <MessageSquare className="h-6 w-6" style={{ color: "var(--accent)" }} /> Chat + Voice
        </h1>
        <button
          onClick={newConversation}
          disabled={busy}
          className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
          style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
        >
          <Plus className="h-4 w-4" /> New conversation
        </button>
      </div>

      <div className="card flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1">
          {/* Conversation sidebar */}
          {sidebarOpen && (
            <div className="flex w-56 shrink-0 flex-col border-r" style={{ borderColor: "var(--card-border)" }}>
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-dim)" }}>
                  Conversations
                </span>
                <button
                  onClick={() => setSidebarOpen(false)}
                  className="rounded p-1"
                  style={{ color: "var(--text-faint)" }}
                  aria-label="Hide sidebar"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
              </div>
              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
                {sessions.length === 0 && (
                  <div className="px-2 py-4 text-xs" style={{ color: "var(--text-faint)" }}>
                    No conversations yet.
                  </div>
                )}
                {sessions.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => selectSession(s.id)}
                    className="w-full rounded-lg px-3 py-2 text-left text-xs"
                    style={
                      s.id === activeId
                        ? { background: "rgba(124,108,255,0.12)", color: "var(--text)" }
                        : { color: "var(--text-dim)" }
                    }
                  >
                    <div className="truncate font-medium">
                      {s.title || s.last_message || s.id.slice(0, 20)}
                    </div>
                    {s.message_count != null && (
                      <div className="mt-0.5 text-[10px]" style={{ color: "var(--text-faint)" }}>
                        {s.message_count} messages
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Messages */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              {!sidebarOpen && (
                <button
                  onClick={() => setSidebarOpen(true)}
                  className="mb-2 flex items-center gap-1 rounded-lg border px-2 py-1 text-xs"
                  style={{ borderColor: "var(--card-border)", color: "var(--text-dim)" }}
                >
                  <ChevronRight className="h-3 w-3" /> Conversations
                </button>
              )}
              {messages.length === 0 && !busy && (
                <div className="flex h-full items-center justify-center text-sm" style={{ color: "var(--text-faint)" }}>
                  Ask me anything — type below or tap the mic to speak.
                </div>
              )}
              {messages.map((m, i) => (
                <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div
                    className="max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm"
                    style={
                      m.role === "user"
                        ? { background: "linear-gradient(135deg, var(--accent), var(--accent-2))", color: "#fff" }
                        : { background: "color-mix(in srgb, var(--bg) 60%, transparent)", color: "var(--text)", border: "1px solid var(--card-border)" }
                    }
                  >
                    {m.reasoning && (
                      <details className="mb-2">
                        <summary className="flex cursor-pointer items-center gap-1 text-xs" style={{ color: "var(--text-faint)" }}>
                          <Brain className="h-3 w-3" /> Thinking
                        </summary>
                        <div className="mt-1 whitespace-pre-wrap text-xs" style={{ color: "var(--text-dim)" }}>
                          {m.reasoning}
                        </div>
                      </details>
                    )}
                    {m.content}
                  </div>
                </div>
              ))}
              {thinking && (
                <div className="flex justify-start">
                  <div className="max-w-[85%] rounded-2xl border px-4 py-2.5 text-xs" style={{ borderColor: "var(--card-border)", color: "var(--text-dim)" }}>
                    <div className="mb-1 flex items-center gap-1 font-semibold" style={{ color: "var(--text-faint)" }}>
                      <Brain className="h-3 w-3 animate-pulse" /> Thinking…
                    </div>
                    <div className="whitespace-pre-wrap">{thinking.slice(-600)}</div>
                  </div>
                </div>
              )}
              {busy && !thinking && (
                <div className="flex justify-start">
                  <div className="flex items-center gap-2 rounded-2xl border px-4 py-2.5 text-sm" style={{ borderColor: "var(--card-border)", color: "var(--text-faint)" }}>
                    <Loader2 className="h-4 w-4 animate-spin" /> Hermes is thinking…
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            {error && (
              <div className="border-t px-4 py-2 text-xs" style={{ borderColor: "var(--card-border)", color: "var(--red)" }}>
                {error}
              </div>
            )}

            {/* Composer */}
            <div className="flex items-center gap-2 border-t p-3" style={{ borderColor: "var(--card-border)" }}>
              <button
                onClick={toggleMic}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
                style={listening ? { background: "var(--red)", color: "#fff" } : { background: "rgba(124,108,255,0.12)", color: "var(--accent)" }}
                aria-label="Voice input"
              >
                {listening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              </button>
              {listening && (
                <span className="animate-pulse text-xs font-semibold" style={{ color: "var(--red)" }}>
                  Listening…
                </span>
              )}
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") send(input); }}
                placeholder={activeId ? "Message Hermes…" : "Start a new conversation first…"}
                disabled={!activeId}
                className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2 text-sm outline-none disabled:opacity-50"
                style={{ borderColor: "var(--card-border)", color: "var(--text)" }}
              />
              <button
                onClick={() => send(input)}
                disabled={busy || !input.trim() || !activeId}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-white disabled:opacity-50"
                style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
                aria-label="Send"
              >
                <Send className="h-4 w-4" />
              </button>
              <button
                onClick={() => setVoiceOn((v) => !v)}
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border ${voiceOn ? "" : "opacity-40"}`}
                style={{ borderColor: "var(--card-border)", color: "var(--accent-2)" }}
                aria-label="Toggle spoken responses"
                title="Spoken responses (Jarvis)"
              >
                <Volume2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
