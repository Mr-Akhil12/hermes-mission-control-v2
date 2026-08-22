"use client";

// Composer — extracted from the chat page so typing only re-renders this
// component instead of the whole page (sidebar + stats + messages). This is
// the fix for the laggy textbox: keystrokes no longer re-render everything.

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff, Send, Square, Maximize2, Minimize2, Volume2, Paperclip, X } from "lucide-react";
import { SlashAutocomplete } from "./SlashAutocomplete";
import { dbg } from "@/lib/chat-debug";

// An attachment the user picked in the composer — not yet uploaded.
export type PendingAttachment = {
  name: string;
  size: number;
  b64: string; // base64 payload (uploaded with the message)
  mime: string;
};

export const Composer = memo(function Composer({
  input,
  draftKey,
  setInput,
  onDraftChange,
  send,
  busy,
  stopRun,
  listening,
  toggleMic,
  composerExpanded,
  setComposerExpanded,
  voiceOn,
  setVoiceOn,
  attachments,
  setAttachments,
}: {
  input: string;
  draftKey: string;
  setInput: (v: string) => void;
  onDraftChange: (v: string) => void;
  send: (text: string) => void;
  busy: boolean;
  stopRun: () => void;
  listening: boolean;
  toggleMic: () => void;
  composerExpanded: boolean;
  setComposerExpanded: (v: boolean | ((p: boolean) => boolean)) => void;
  voiceOn: boolean;
  setVoiceOn: (v: boolean | ((p: boolean) => boolean)) => void;
  attachments: PendingAttachment[];
  setAttachments: (v: PendingAttachment[] | ((p: PendingAttachment[]) => PendingAttachment[])) => void;
}) {
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  // Keep high-frequency typing local. The page's per-session draft ref is
  // updated without page state, so keystrokes do not reconcile the sidebar,
  // transcript, or live chain; parent state syncs only for external editors.
  const [localInput, setLocalInput] = useState(input);
  const syncedDraftKey = useRef(draftKey);
  const dropCount = useRef(0);

  useEffect(() => {
    setLocalInput(input);
    // External edits (voice input / expanded composer) must update the durable
    // draft too. On a conversation-key change, skip this write so an old
    // prop value can never overwrite the newly selected session's draft.
    if (syncedDraftKey.current === draftKey) onDraftChange(input);
    syncedDraftKey.current = draftKey;
  }, [input, draftKey, onDraftChange]);

  const applyAutocomplete = useCallback((value: string) => {
    setLocalInput(value);
    onDraftChange(value);
  }, [onDraftChange]);

  useEffect(() => {
    dbg("render", `Composer commit draftKey=${draftKey} chars=${localInput.length} busy=${busy}`);
  });

  // Auto-resize the composer textarea to fit its content (wraps after one
  // line, grows up to a cap). Collapses back to a single line when cleared.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [localInput]);

  // Shared file→attachment pipeline (click picker + drag-drop).
  const addFiles = (files: FileList | File[]) => {
    const list = Array.from(files ?? []);
    if (list.length === 0) return;
    const allowed = list.filter((f) => f.size <= 20 * 1024 * 1024);
    const oversized = list.length - allowed.length;
    Promise.all(
      allowed.map(
        (f) =>
          new Promise<PendingAttachment>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const b64 = String(reader.result ?? "").split(",")[1] ?? "";
              resolve({ name: f.name, size: f.size, b64, mime: f.type || "application/octet-stream" });
            };
            reader.onerror = reject;
            reader.readAsDataURL(f);
          })
      )
    )
      .then((items) => {
        setAttachments((prev) => [...prev, ...items]);
        if (oversized > 0 && !localInput.trim()) {
          const warning = `⚠️ ${oversized} file(s) skipped (max 20MB). `;
          setLocalInput(warning);
          onDraftChange(warning);
        }
      })
      .catch(() => {});
  };

  const pickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ?? [];
    e.target.value = "";
    addFiles(files);
  };

  // Drag-and-drop onto the composer: files land as attachments, exactly like
  // tapping the paperclip. The drop zone is the whole composer row.
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dropCount.current += 1;
    setDragOver(false);
    addFiles(e.dataTransfer.files);
  };

  return (
    <div
      className="relative flex items-end gap-2 border-t p-3"
      style={{
        borderColor: "var(--card-border)",
        ...(dragOver
          ? { boxShadow: "inset 0 0 0 2px var(--accent)", background: "rgba(124,108,255,0.08)" }
          : {}),
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={(e) => {
        // Only clear when the drag truly leaves the composer (not children).
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      <SlashAutocomplete input={localInput} onApply={applyAutocomplete} />
      <input
        ref={fileRef}
        type="file"
        multiple
        className="hidden"
        onChange={pickFiles}
        aria-label="Attach files"
      />
      <button
        onClick={() => fileRef.current?.click()}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
        style={{ background: "rgba(124,108,255,0.12)", color: "var(--accent)" }}
        aria-label="Attach files"
        title="Attach files (saved on the Hermes machine so I can read them)"
      >
        <Paperclip className="h-4 w-4" />
      </button>
      {attachments.length > 0 && (
        <div className="absolute bottom-full left-3 flex max-w-full flex-wrap gap-1.5 pb-1.5">
          {attachments.map((a, i) => (
            <span
              key={`${a.name}-${i}`}
              className="flex max-w-[240px] items-center gap-1.5 rounded-lg border px-2 py-1 text-[10px]"
              style={{ borderColor: "var(--card-border)", background: "var(--bg-2)", color: "var(--text-dim)" }}
            >
              <span className="truncate">{a.name}</span>
              <span className="shrink-0 opacity-60">{(a.size / 1024).toFixed(0)}KB</span>
              <button
                onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                className="shrink-0 rounded p-0.5 hover:bg-white/10"
                style={{ color: "var(--text-faint)" }}
                aria-label={`Remove ${a.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
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
        value={localInput}
        onChange={(e) => {
          setLocalInput(e.target.value);
          onDraftChange(e.target.value);
        }}
        onKeyDown={(e) => {
          // Enter sends; Shift+Enter inserts a newline.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            setInput(localInput);
            send(localInput);
            setLocalInput("");
            onDraftChange("");
          }
        }}
        rows={1}
        placeholder=""
        disabled={false}
        className="min-w-0 flex-1 resize-none overflow-y-auto rounded-lg border bg-transparent px-3 py-2 text-sm leading-relaxed outline-none disabled:opacity-50"
        style={{ borderColor: "var(--card-border)", color: "var(--text)", maxHeight: 120 }}
      />
      <button
        onClick={() => {
          setInput(localInput);
          onDraftChange(localInput);
          setComposerExpanded((v) => !v);
        }}
        disabled={false}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border disabled:opacity-40"
        style={{ borderColor: "var(--card-border)", color: "var(--text-dim)" }}
        aria-label={composerExpanded ? "Collapse composer" : "Expand composer"}
        title={composerExpanded ? "Collapse composer" : "Expand composer to fill the chat container"}
      >
        {composerExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
      </button>
      <button
        onClick={() => {
          if (busy) {
            stopRun();
          } else {
            setInput(localInput);
            send(localInput);
            setLocalInput("");
            onDraftChange("");
          }
        }}
        disabled={!busy && !localInput.trim()}
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
