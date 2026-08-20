"use client";

import {
  Wrench,
  TerminalSquare,
  FileText,
  Globe,
  Search,
  Brain,
  CheckCircle2,
  XCircle,
  Loader2,
  CircleSlash2,
} from "lucide-react";
import type { ToolEvent } from "@/lib/chat-types";

// Friendly label per tool name — used in "summary" mode.
const TOOL_LABELS: Record<string, string> = {
  _thinking: "Thinking",
  terminal: "Running terminal command",
  read_file: "Reading file",
  write_file: "Writing file",
  patch: "Editing file",
  web_search: "Searching the web",
  web_extract: "Reading web page",
  browser_navigate: "Opening browser",
  browser_click: "Clicking page element",
  browser_type: "Typing in browser",
  browser_vision: "Inspecting screenshot",
  search_files: "Searching files",
  delegate_task: "Delegating to subagent",
  execute_code: "Running code",
  skill_view: "Loading skill",
  memory: "Updating memory",
  session_search: "Searching past sessions",
};

function toolIcon(name: string) {
  const n = name.toLowerCase();
  if (n.includes("terminal") || n.includes("execute") || n.includes("code"))
    return <TerminalSquare className="h-3.5 w-3.5" />;
  if (n.includes("file") || n.includes("patch") || n.includes("write") || n.includes("read"))
    return <FileText className="h-3.5 w-3.5" />;
  if (n.includes("search")) return <Search className="h-3.5 w-3.5" />;
  if (n.includes("web") || n.includes("browser") || n.includes("http"))
    return <Globe className="h-3.5 w-3.5" />;
  if (n.includes("think")) return <Brain className="h-3.5 w-3.5" />;
  return <Wrench className="h-3.5 w-3.5" />;
}

function prettyToolName(name: string) {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function ToolCallChip({
  tool,
  mode,
}: {
  tool: ToolEvent;
  mode: "technical" | "summary" | "count";
}) {
  const done = tool.durationMs !== undefined;
  const failed = !!tool.error;
  // ChatGPT-style: just the tool name, no preview clutter. The live elapsed
  // ticks every second via the page's busy-timer re-render — the pulse.
  const label =
    mode === "summary"
      ? TOOL_LABELS[tool.name] ?? `Using ${prettyToolName(tool.name)}`
      : prettyToolName(tool.name);
  const elapsedMs = done ? (tool.durationMs ?? 0) : Math.max(0, Date.now() - (tool.startedAt ?? Date.now()));

  return (
    <div
      className="flex max-w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs"
      style={{
        borderColor: failed ? "color-mix(in srgb, var(--red) 40%, transparent)" : "var(--card-border)",
        background: failed ? "rgba(255,92,92,0.08)" : "color-mix(in srgb, var(--bg) 55%, transparent)",
        color: failed ? "var(--red)" : "var(--text-dim)",
      }}
    >
      {done ? (
        failed ? (
          <XCircle className="h-3.5 w-3.5 shrink-0" />
        ) : tool.interrupted ? (
          <CircleSlash2 className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--text-faint)" }} />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--green)" }} />
        )
      ) : (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" style={{ color: "var(--accent)" }} />
      )}
      <span className="truncate">{label}</span>
      {tool.interrupted && !failed && (
        <span className="ml-auto shrink-0 text-[10px] italic opacity-60">interrupted</span>
      )}
      {!tool.interrupted && (
        <span className="ml-auto shrink-0 font-mono text-[10px] opacity-70">
          {(elapsedMs / 1000).toFixed(1)}s
        </span>
      )}
    </div>
  );
}

export function ToolCallStack({
  tools,
  mode,
  countOnly,
}: {
  tools: ToolEvent[];
  mode: "technical" | "summary" | "count";
  countOnly?: boolean;
}) {
  if (tools.length === 0) return null;
  if (countOnly || mode === "count") {
    return (
      <div className="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-faint)" }}>
        <Wrench className="h-3.5 w-3.5" />
        {tools.length} tool call{tools.length === 1 ? "" : "s"}
        {tools.filter((t) => t.error).length > 0 && (
          <span style={{ color: "var(--red)" }}>
            · {tools.filter((t) => t.error).length} failed
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="flex max-w-full flex-col gap-1">
      {tools.map((t, i) => (
        <ToolCallChip key={`${t.name}-${i}`} tool={t} mode={mode} />
      ))}
    </div>
  );
}
