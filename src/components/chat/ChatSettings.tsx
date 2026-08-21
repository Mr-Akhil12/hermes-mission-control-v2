"use client";

import { memo, useEffect, useRef, useState } from "react";
import { Settings2, Brain, Wrench, BarChart3 } from "lucide-react";
import type { ChatSettings } from "@/lib/chat-types";

const STORAGE_KEY = "hermes-chat-settings";

export const DEFAULT_SETTINGS: ChatSettings = {
  reasoning: "full",
  tools: "summary",
  showStats: true,
  autoScroll: true,
};

export function loadSettings(): ChatSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return DEFAULT_SETTINGS;
}

export function saveSettings(s: ChatSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

type Option<T extends string> = { value: T; label: string; hint: string };

const REASONING_OPTIONS: Option<ChatSettings["reasoning"]>[] = [
  { value: "full", label: "Full stream", hint: "Every thinking token, live" },
  { value: "partial", label: "Tail preview", hint: "Last ~40 lines of reasoning" },
  { value: "hidden", label: "Hidden", hint: "Skip reasoning, just the output" },
];

const TOOL_OPTIONS: Option<ChatSettings["tools"]>[] = [
  { value: "technical", label: "Technical", hint: "Tool name + args (like CLI)" },
  { value: "summary", label: "Summary", hint: "Friendly description per call" },
  { value: "count", label: "Count only", hint: "Just a running tool counter" },
];

export const ChatSettingsButton = memo(function ChatSettingsButton({
  settings,
  onChange,
}: {
  settings: ChatSettings;
  onChange: (s: ChatSettings) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const toggle = () => {
    if (!open && ref.current) {
      const r = ref.current.getBoundingClientRect();
      const isMobile = window.innerWidth < 768;
      setPos({
        top: r.bottom + 8,
        // Mobile: pin the popup to the right edge of the screen so it never
        // floats mid-screen or overflows left when the header wraps.
        // Desktop: anchor to the button's right edge.
        right: isMobile ? 12 : Math.max(8, window.innerWidth - r.right),
      });
    }
    setOpen((o) => !o);
  };

  const set = <K extends keyof ChatSettings>(key: K, value: ChatSettings[K]) => {
    const next = { ...settings, [key]: value };
    saveSettings(next);
    onChange(next);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={toggle}
        className="flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold"
        style={{ borderColor: "var(--card-border)", color: "var(--text-dim)" }}
        title="Chat display settings"
        aria-label="Chat display settings"
      >
        <Settings2 className="h-3.5 w-3.5" />
        Display
      </button>

      {open && pos && (
        <div
          className="fixed z-[60] w-80 max-w-[calc(100vw-1rem)] rounded-xl border p-3 shadow-xl"
          style={{ top: pos.top, right: pos.right, background: "var(--bg-2)", borderColor: "var(--card-border)" }}
        >
          <div className="space-y-3">
            {/* Reasoning */}
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold" style={{ color: "var(--text-dim)" }}>
                <Brain className="h-3.5 w-3.5" style={{ color: "var(--accent)" }} />
                Reasoning display
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {REASONING_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    onClick={() => set("reasoning", o.value)}
                    className="rounded-lg border px-2 py-1.5 text-left text-[11px] font-medium leading-tight"
                    style={
                      settings.reasoning === o.value
                        ? { borderColor: "var(--accent)", background: "rgba(124,108,255,0.12)", color: "var(--text)" }
                        : { borderColor: "var(--card-border)", color: "var(--text-dim)" }
                    }
                  >
                    {o.label}
                    <span className="mt-0.5 block text-[10px] font-normal opacity-70">{o.hint}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Tool calls */}
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold" style={{ color: "var(--text-dim)" }}>
                <Wrench className="h-3.5 w-3.5" style={{ color: "var(--accent-2)" }} />
                Tool call display
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {TOOL_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    onClick={() => set("tools", o.value)}
                    className="rounded-lg border px-2 py-1.5 text-left text-[11px] font-medium leading-tight"
                    style={
                      settings.tools === o.value
                        ? { borderColor: "var(--accent)", background: "rgba(124,108,255,0.12)", color: "var(--text)" }
                        : { borderColor: "var(--card-border)", color: "var(--text-dim)" }
                    }
                  >
                    {o.label}
                    <span className="mt-0.5 block text-[10px] font-normal opacity-70">{o.hint}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Stats toggles */}
            <div className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: "var(--text-dim)" }}>
              <BarChart3 className="h-3.5 w-3.5" style={{ color: "var(--accent-3)" }} />
              Run stats footer
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                onClick={() => set("showStats", !settings.showStats)}
                className="rounded-lg border px-2 py-1.5 text-left text-[11px] font-medium"
                style={
                  settings.showStats
                    ? { borderColor: "var(--accent)", background: "rgba(124,108,255,0.12)", color: "var(--text)" }
                    : { borderColor: "var(--card-border)", color: "var(--text-dim)" }
                }
              >
                Tokens / usage
              </button>
              <button
                onClick={() => set("autoScroll", !settings.autoScroll)}
                className="rounded-lg border px-2 py-1.5 text-left text-[11px] font-medium"
                style={
                  settings.autoScroll
                    ? { borderColor: "var(--accent)", background: "rgba(124,108,255,0.12)", color: "var(--text)" }
                    : { borderColor: "var(--card-border)", color: "var(--text-dim)" }
                }
              >
                Auto-scroll
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
