"use client";

// Fullscreen chain view — the complete train of thought for one assistant
// turn, in order: reasoning → tool call → reasoning → tool call → answer.
// Shows the full logic and actions, not just the final text.

import { useState } from "react";
import {
  Brain, ChevronDown, ChevronRight, X, Loader2, Wrench, CheckCircle2,
  XCircle, TerminalSquare, FileText, Globe, Search, CircleSlash2,
} from "lucide-react";
import type { ChainSegment, ChatSegment, ToolCallInfo, ToolEvent } from "@/lib/chat-types";

function toolIcon(name: string) {
  const n = name.toLowerCase();
  if (n.includes("terminal") || n.includes("execute") || n.includes("code"))
    return <TerminalSquare className="h-3.5 w-3.5" />;
  if (n.includes("file") || n.includes("patch") || n.includes("write") || n.includes("read"))
    return <FileText className="h-3.5 w-3.5" />;
  if (n.includes("search")) return <Search className="h-3.5 w-3.5" />;
  if (n.includes("web") || n.includes("browser") || n.includes("http"))
    return <Globe className="h-3.5 w-3.5" />;
  return <Wrench className="h-3.5 w-3.5" />;
}

function prettyName(name: string) {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function Collapsible({ title, children, defaultOpen }: { title: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <div className="rounded-lg border" style={{ borderColor: "var(--card-border)" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs font-semibold"
        style={{ color: "var(--text-dim)" }}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {title}
      </button>
      {open && <div className="border-t px-2.5 py-2" style={{ borderColor: "var(--card-border)" }}>{children}</div>}
    </div>
  );
}

export function ChainView({
  reasoning,
  toolCalls,
  liveTools,
  chain,
  segments,
  content,
  onClose,
}: {
  reasoning: string;
  toolCalls: ToolCallInfo[];
  liveTools: ToolEvent[];
  chain?: ChainSegment[];
  segments?: ChatSegment[];
  content: string;
  onClose: () => void;
}) {
  // History toolCalls (with results) and live ToolEvents (in progress) merged
  // into one ordered list. When an ordered `chain` prop is provided (live
  // view), it wins — reasoning and tools are already interleaved in the exact
  // sequence they happened.
  const merged: { name: string; args?: string; result?: string; error?: boolean; live?: boolean }[] = [
    ...toolCalls.map((c) => ({ name: c.name, args: c.args, result: c.result, error: c.error })),
    ...liveTools.map((t) => ({ name: t.name, live: true, error: t.error, args: t.args })),
  ];

  // Ordered segments for the live chain: reasoning blocks and tool chips
  // interleaved exactly as they happened (reasoning → tool → reasoning → tool).
  const liveSegments = chain ?? [];
  // Ordered segments for HISTORY bubbles (persisted ChatSegment[]): same
  // interleave, so the fullscreen view of a past turn matches the live one.
  const historySegments = segments ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <div
        className="flex h-[90dvh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border"
        style={{ background: "var(--bg-2)", borderColor: "var(--card-border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-4 py-2.5" style={{ borderColor: "var(--card-border)" }}>
          <span className="flex items-center gap-2 text-sm font-bold">
            <Brain className="h-4 w-4" style={{ color: "var(--accent)" }} />
            Full chain
            <span className="text-[10px] font-normal" style={{ color: "var(--text-faint)" }}>
              {merged.length} tool call{merged.length === 1 ? "" : "s"} · reasoning + actions in order
            </span>
          </span>
          <button
            onClick={onClose}
            className="rounded p-1.5 hover:bg-white/10"
            style={{ color: "var(--text-faint)" }}
            aria-label="Close chain view"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {/* Ordered chain (live): reasoning and tools interleaved as they
              happened — the user's core ask: reasoning ALWAYS shows, tools
              ALWAYS show, in sequence, never split into disappearing sections. */}
          {liveSegments.length > 0 ? (
            liveSegments.map((seg, i) =>
              seg.kind === "reasoning" ? (
                <div key={`r-${i}`} className="rounded-lg border-l-2 px-3 py-2" style={{ borderLeftColor: "var(--accent)", background: "rgba(124,108,255,0.06)" }}>
                  <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: "var(--text-faint)" }}>
                    <Brain className="h-3 w-3" style={{ color: "var(--accent)" }} />
                    Reasoning
                  </div>
                  <div className="whitespace-pre-wrap text-xs leading-relaxed" style={{ color: "var(--text-dim)" }}>
                    {seg.text}
                  </div>
                </div>
              ) : (
                <div key={`t-${i}`} className="space-y-1.5">
                  <div
                    className="flex items-center gap-2 rounded-lg border px-3 py-2 text-xs"
                    style={{
                      borderColor: seg.tool.error ? "color-mix(in srgb, var(--red) 40%, transparent)" : "var(--card-border)",
                      background: seg.tool.error ? "rgba(255,92,92,0.08)" : "color-mix(in srgb, var(--bg) 55%, transparent)",
                      color: seg.tool.error ? "var(--red)" : "var(--text-dim)",
                    }}
                  >
                    {seg.tool.durationMs === undefined ? (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" style={{ color: "var(--accent)" }} />
                    ) : seg.tool.error ? (
                      <XCircle className="h-3.5 w-3.5 shrink-0" />
                    ) : seg.tool.interrupted ? (
                      <CircleSlash2 className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--text-faint)" }} />
                    ) : (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--green)" }} />
                    )}
                    {toolIcon(seg.tool.name)}
                    <span className="font-semibold">{prettyName(seg.tool.name)}</span>
                    {seg.tool.durationMs === undefined && <span className="ml-auto text-[10px] italic opacity-60">in progress…</span>}
                    {seg.tool.durationMs !== undefined && (
                      <span className="ml-auto font-mono text-[10px] opacity-70">{(seg.tool.durationMs / 1000).toFixed(1)}s</span>
                    )}
                  </div>
                  {seg.tool.args && (
                    <Collapsible title={<span className="font-mono text-[10px]">args</span>}>
                      <pre className="overflow-x-auto whitespace-pre-wrap text-[10px] leading-relaxed" style={{ color: "var(--text-dim)" }}>
                        {seg.tool.args}
                      </pre>
                    </Collapsible>
                  )}
                </div>
              )
            )
          ) : historySegments.length > 0 ? (
            historySegments.map((seg, i) =>
              seg.kind === "reasoning" ? (
                <div key={`hr-${i}`} className="rounded-lg border-l-2 px-3 py-2" style={{ borderLeftColor: "var(--accent)", background: "rgba(124,108,255,0.06)" }}>
                  <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: "var(--text-faint)" }}>
                    <Brain className="h-3 w-3" style={{ color: "var(--accent)" }} />
                    Reasoning
                  </div>
                  <div className="whitespace-pre-wrap text-xs leading-relaxed" style={{ color: "var(--text-dim)" }}>
                    {seg.text}
                  </div>
                </div>
              ) : (
                <div key={`ht-${i}`} className="space-y-1.5">
                  {seg.calls.map((c, j) => (
                    <div key={`htc-${j}`} className="space-y-1.5">
                      <div
                        className="flex items-center gap-2 rounded-lg border px-3 py-2 text-xs"
                        style={{
                          borderColor: c.error ? "color-mix(in srgb, var(--red) 40%, transparent)" : "var(--card-border)",
                          background: c.error ? "rgba(255,92,92,0.08)" : "color-mix(in srgb, var(--bg) 55%, transparent)",
                          color: c.error ? "var(--red)" : "var(--text-dim)",
                        }}
                      >
                        {c.error ? (
                          <XCircle className="h-3.5 w-3.5 shrink-0" />
                        ) : c.interrupted ? (
                          <CircleSlash2 className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--text-faint)" }} />
                        ) : c.result !== undefined || c.durationMs !== undefined ? (
                          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--green)" }} />
                        ) : (
                          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" style={{ color: "var(--accent)" }} />
                        )}
                        {toolIcon(c.name)}
                        <span className="font-semibold">{prettyName(c.name)}</span>
                        {c.interrupted && (
                          <span className="ml-auto text-[10px] italic opacity-60">interrupted</span>
                        )}
                        {c.durationMs !== undefined && !c.interrupted && (
                          <span className="ml-auto font-mono text-[10px] opacity-70">{(c.durationMs / 1000).toFixed(1)}s</span>
                        )}
                      </div>
                      {c.args && (
                        <Collapsible title={<span className="font-mono text-[10px]">args</span>}>
                          <pre className="overflow-x-auto whitespace-pre-wrap text-[10px] leading-relaxed" style={{ color: "var(--text-dim)" }}>
                            {c.args}
                          </pre>
                        </Collapsible>
                      )}
                      {c.result !== undefined && (
                        <Collapsible title={<span className="font-mono text-[10px]">result ({c.result.length} chars)</span>}>
                          <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap text-[10px] leading-relaxed" style={{ color: "var(--text-dim)" }}>
                            {c.result || "(empty)"}
                          </pre>
                        </Collapsible>
                      )}
                    </div>
                  ))}
                </div>
              )
            )
          ) : (
            <>
              {/* History fallback: reasoning first, then tools in order */}
              {reasoning && (
                <div className="rounded-lg border-l-2 px-3 py-2" style={{ borderLeftColor: "var(--accent)", background: "rgba(124,108,255,0.06)" }}>
                  <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: "var(--text-faint)" }}>
                    <Brain className="h-3 w-3" style={{ color: "var(--accent)" }} />
                    Reasoning
                  </div>
                  <div className="whitespace-pre-wrap text-xs leading-relaxed" style={{ color: "var(--text-dim)" }}>
                    {reasoning}
                  </div>
                </div>
              )}

              {merged.map((t, i) => (
                <div key={i} className="space-y-1.5">
                  <div
                    className="flex items-center gap-2 rounded-lg border px-3 py-2 text-xs"
                    style={{
                      borderColor: t.error ? "color-mix(in srgb, var(--red) 40%, transparent)" : "var(--card-border)",
                      background: t.error ? "rgba(255,92,92,0.08)" : "color-mix(in srgb, var(--bg) 55%, transparent)",
                      color: t.error ? "var(--red)" : "var(--text-dim)",
                    }}
                  >
                    {t.live ? (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" style={{ color: "var(--accent)" }} />
                    ) : t.error ? (
                      <XCircle className="h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--green)" }} />
                    )}
                    {toolIcon(t.name)}
                    <span className="font-semibold">{prettyName(t.name)}</span>
                    {t.live && <span className="ml-auto text-[10px] italic opacity-60">in progress…</span>}
                  </div>
                  {t.args && (
                    <Collapsible title={<span className="font-mono text-[10px]">args</span>}>
                      <pre className="overflow-x-auto whitespace-pre-wrap text-[10px] leading-relaxed" style={{ color: "var(--text-dim)" }}>
                        {t.args}
                      </pre>
                    </Collapsible>
                  )}
                  {t.result !== undefined && (
                    <Collapsible title={<span className="font-mono text-[10px]">result ({t.result.length} chars)</span>}>
                      <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap text-[10px] leading-relaxed" style={{ color: "var(--text-dim)" }}>
                        {t.result || "(empty)"}
                      </pre>
                    </Collapsible>
                  )}
                </div>
              ))}
            </>
          )}

          {content && (
            <div className="rounded-lg border px-3 py-2" style={{ borderColor: "var(--card-border)" }}>
              <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: "var(--text-faint)" }}>
                <CheckCircle2 className="h-3 w-3" style={{ color: "var(--green)" }} />
                Final answer
              </div>
              <div className="whitespace-pre-wrap text-xs leading-relaxed" style={{ color: "var(--text)" }}>
                {content}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
