"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Send, Mic, MicOff, Volume2, Loader2, MessageSquare } from "lucide-react";

type ChatMsg = { role: "user" | "assistant"; content: string };

export default function ChatPage() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", content: trimmed }]);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, history: messages.slice(-8) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Chat failed");
      const reply = data.message ?? "(no response)";
      setMessages((m) => [...m, { role: "assistant", content: reply }]);
      if (voiceOn) {
        try {
          const synth = window.speechSynthesis;
          const utter = new SpeechSynthesisUtterance(reply.replace(/[#*`>]/g, "").slice(0, 400));
          synth.speak(utter);
        } catch { /* TTS unavailable */ }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, messages, voiceOn]);

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

  return (
    <div className="mx-auto flex h-[calc(100vh-170px)] min-h-[480px] max-w-3xl flex-col">
      <div className="mb-4">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <MessageSquare className="h-6 w-6" style={{ color: "var(--accent)" }} /> Chat + Voice
        </h1>
        <p className="text-sm" style={{ color: "var(--text-dim)" }}>
          Talk to Hermes directly via :8642. Tap the mic for Jarvis mode — hands-free.
        </p>
      </div>

      <div className="card flex min-h-0 flex-1 flex-col">
        {/* Messages */}
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {messages.length === 0 && (
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
                {m.content}
              </div>
            </div>
          ))}
          {busy && (
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
            placeholder="Message Hermes…"
            className="min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
            style={{ borderColor: "var(--card-border)", color: "var(--text)" }}
          />
          <button
            onClick={() => send(input)}
            disabled={busy || !input.trim()}
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
  );
}
