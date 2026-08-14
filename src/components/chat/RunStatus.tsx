"use client";

// Live run status bar — the "initializing agent → thinking → tools → output"
// progression Akhil wants, mirroring the CLI's feel. Shows real state, never
// a static spinner.

import { Loader2, Brain, Wrench, CheckCircle2, BarChart3, Zap } from "lucide-react";
import type { ToolEvent, RunStats } from "@/lib/chat-types";

export type RunPhase = "idle" | "initializing" | "thinking" | "tools" | "streaming" | "done" | "error";

export function PhaseBanner({ phase, toolCount, elapsedSec }: { phase: RunPhase; toolCount: number; elapsedSec?: number }) {
  if (phase === "idle") return null;

  const rows: { phase: RunPhase; label: string; icon: React.ReactNode; done: boolean }[] = [
    { phase: "initializing", label: "Initializing agent", icon: <Zap className="h-3 w-3" />, done: false },
    { phase: "thinking", label: "Thinking", icon: <Brain className="h-3 w-3" />, done: false },
    { phase: "tools", label: `Tool calls (${toolCount})`, icon: <Wrench className="h-3 w-3" />, done: false },
    { phase: "streaming", label: "Streaming response", icon: <Loader2 className="h-3 w-3" />, done: false },
  ];

  const phaseOrder = ["initializing", "thinking", "tools", "streaming"] as const;
  const idx = phaseOrder.indexOf(phase as (typeof phaseOrder)[number]);
  const fmt = elapsedSec != null ? `${Math.floor(elapsedSec / 60)}:${String(elapsedSec % 60).padStart(2, "0")}` : "";

  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-3 py-2 text-xs" style={{ borderColor: "var(--card-border)", background: "color-mix(in srgb, var(--bg) 55%, transparent)" }}>
      {rows.map((r, i) => {
        const active = i === idx;
        const done = i < idx;
        return (
          <span key={r.phase} className="flex items-center gap-1.5" style={{ color: active ? "var(--text)" : done ? "var(--green)" : "var(--text-faint)", opacity: active ? 1 : done ? 0.85 : 0.55 }}>
            {active ? <Loader2 className="h-3 w-3 animate-spin" /> : done ? <CheckCircle2 className="h-3 w-3" /> : r.icon}
            {r.label}
          </span>
        );
      })}
      {fmt && (
        <span className="ml-auto flex items-center gap-1.5 font-mono text-[10px]" style={{ color: "var(--text-faint)" }}>
          <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: "var(--accent)" }} />
          {fmt}
        </span>
      )}
    </div>
  );
}

function fmtTokens(n?: number) {
  if (n === undefined || n === null) return "—";
  return n.toLocaleString();
}

function fmtDuration(ms?: number) {
  if (!ms) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function RunStatsFooter({ stats, phase }: { stats: RunStats | null; phase: RunPhase }) {
  const live =
    stats && phase !== "done" && phase !== "error" && phase !== "idle";

  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border px-3 py-1.5 font-mono text-[10px]"
      style={{ borderColor: "var(--card-border)", color: "var(--text-faint)" }}
    >
      <span className="flex items-center gap-1">
        <Wrench className="h-3 w-3" />
        {stats?.toolCount ?? 0} tool{stats?.toolCount === 1 ? "" : "s"}
        {stats && stats.failedTools > 0 && (
          <span style={{ color: "var(--red)" }}> · {stats.failedTools} failed</span>
        )}
      </span>
      <span className="flex items-center gap-1">
        <BarChart3 className="h-3 w-3" />
        {stats?.runtime?.model ? (
          <>
            <span style={{ color: "var(--accent-2)" }}>{stats.runtime.model}</span>
            {stats.runtime.provider && <span>· {stats.runtime.provider}</span>}
          </>
        ) : live ? (
          "model…"
        ) : (
          "—"
        )}
      </span>
      <span className="flex items-center gap-1">
        ⬇ {fmtTokens(stats?.usage?.input_tokens)}
      </span>
      <span className="flex items-center gap-1">
        ⬆ {fmtTokens(stats?.usage?.output_tokens)}
      </span>
      <span className="flex items-center gap-1">
        Σ {fmtTokens(stats?.usage?.total_tokens)}
      </span>
      <span className="ml-auto">
        {live ? "running…" : `${fmtDuration(stats?.durationMs)} total`}
      </span>
    </div>
  );
}
