"use client";

// Composer — extracted from the chat page so typing only re-renders this
// component instead of the whole page (sidebar + stats + messages). This is
// the fix for the laggy textbox: keystrokes no longer re-render everything.

import { memo, useEffect, useRef } from "react";
import { Mic, MicOff, Send, Square, Maximize2, Minimize2, Volume2 } from "lucide-react";
import { SlashAutocomplete } from "./SlashAutocomplete";

export const Composer = memo(function Composer({
  input,
  setInput,
  send,
  busy,
  stopRun,
  activeId,
  listening,
  toggleMic,
  composerExpanded,
  setComposerExpanded,
  voiceOn,
  setVoiceOn,
}: {
  input: string;
  setInput: (v: string) => void;
  send: (text: string) => void;
  busy: boolean;
  stopRun: () => void;
  activeId: string | null;
  listening: boolean;
  toggleMic: () => void;
  composerExpanded: boolean;
  setComposerExpanded: (v: boolean | ((p: boolean) => boolean)) => void;
  voiceOn: boolean;
  setVoiceOn: (v: boolean | ((p: boolean) => boolean)) => void;
}) {
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize the composer textarea to fit its content (wraps after one
  // line, grows up to a cap). Collapses back to a single line when cleared.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input]);

  return (
    <div className="relative flex items-end gap-2 border-t p-3" style={{ borderColor: "var(--card-border)" }}>
      <SlashAutocomplete input={input} onApply={setInput} />
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
      <textarea
        ref={composerRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends; Shift+Enter inserts a newline.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send(input);
          }
        }}
        rows={1}
        placeholder={activeId ? "Message Hermes…  (type / for commands)" : "Type your first message to start…"}
        disabled={busy}
        className="min-w-0 flex-1 resize-none overflow-y-auto rounded-lg border bg-transparent px-3 py-2 text-sm leading-relaxed outline-none disabled:opacity-50"
        style={{ borderColor: "var(--card-border)", color: "var(--text)", maxHeight: 120 }}
      />
      <button
        onClick={() => setComposerExpanded((v) => !v)}
        disabled={busy}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border disabled:opacity-40"
        style={{ borderColor: "var(--card-border)", color: "var(--text-dim)" }}
        aria-label={composerExpanded ? "Collapse composer" : "Expand composer"}
        title={composerExpanded ? "Collapse composer" : "Expand composer to fill the chat container"}
      >
        {composerExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
      </button>
      <button
        onClick={() => (busy ? stopRun() : send(input))}
        disabled={!busy && !input.trim()}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-white disabled:opacity-50"
        style={{ background: busy ? "rgba(255,92,92,0.85)" : "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
        aria-label={busy ? "Stop" : "Send"}
        title={busy ? "Stop this run (interrupts the agent server-side)" : "Send"}
      >
        {busy ? <Square className="h-4 w-4" /> : <Send className="h-4 w-4" />}
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
  );
});
