"use client";

// Message bubble with reasoning disclosure, tool-call chips and markdown-lite
// rendering. Reasoning display respects the user's setting.

import { memo, useState } from "react";
import { Brain, ChevronDown, ChevronRight, Wrench, CheckCircle2, XCircle, Loader2, TerminalSquare, FileText, Globe, Search, Maximize2 } from "lucide-react";
import type { ChatSettings, ChatMsg, ToolEvent, ToolCallInfo } from "@/lib/chat-types";
import { ToolCallStack } from "./ToolCalls";
import { ChainView } from "./ChainView";

/** Tiny markdown renderer: **bold**, `code`, ```fences```, *italic*, links. */
export const MarkdownLite = memo(function MarkdownLite({ text }: { text: string }) {
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|\[[^\]]+\]\([^)]+\))/g);

  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("```")) {
          const code = part.slice(3, -3).replace(/^\n|\n$/g, "");
          return (
            <pre
              key={i}
              className="my-1.5 overflow-x-auto rounded-lg border p-2 text-xs leading-relaxed"
              style={{
                borderColor: "var(--card-border)",
                background: "color-mix(in srgb, var(--bg) 70%, transparent)",
                color: "var(--text-dim)",
              }}
            >
              <code>{code}</code>
            </pre>
          );
        }
        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <code
              key={i}
              className="rounded px-1 py-0.5 text-[0.9em]"
              style={{ background: "rgba(124,108,255,0.10)", color: "var(--accent-2)" }}
            >
              {part.slice(1, -1)}
            </code>
          );
        }
        if (part.startsWith("**") && part.endsWith("**")) {
          return (
            <strong key={i} className="font-semibold">
              {part.slice(2, -2)}
            </strong>
          );
        }
        if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
          return <em key={i}>{part.slice(1, -1)}</em>;
        }
        const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (link) {
          return (
            <a
              key={i}
              href={link[2]}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
              style={{ color: "var(--accent-2)" }}
            >
              {link[1]}
            </a>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
});

function ReasoningBlock({ text, mode }: { text: string; mode: ChatSettings["reasoning"] }) {
  const [open, setOpen] = useState(false);
  if (!text || mode === "hidden") return null;

  const display =
    mode === "partial" && text.length > 900 ? text.slice(-900) : text;
  const wasTrimmed = display !== text;

  return (
    <div
      className="mb-2 rounded-lg border-l-2 px-2.5 py-1.5"
      style={{ borderLeftColor: "var(--accent)", background: "rgba(124,108,255,0.06)" }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 text-[11px] font-semibold"
        style={{ color: "var(--text-faint)" }}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Brain className="h-3 w-3" style={{ color: "var(--accent)" }} />
        {mode === "partial" ? "Reasoning (tail)" : "Reasoning"}
        <span className="ml-auto font-normal opacity-70">{text.length} chars</span>
      </button>
      {open && (
        <div
          className="mt-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed"
          style={{ color: "var(--text-dim)" }}
        >
          {display}
          {wasTrimmed && (
            <div className="mt-1 text-[10px] italic opacity-60">
              (preview mode — showing tail)
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const MessageBubble = memo(function MessageBubble({
  msg,
  settings,
  tools,
}: {
  msg: ChatMsg;
  settings: ChatSettings;
  tools?: ToolEvent[];
}) {
  const isUser = msg.role === "user";
  const isSys = msg.role === "system";
  const [chainOpen, setChainOpen] = useState(false);

  if (isSys) {
    return (
      <div className="flex justify-center">
        <div
          className="max-w-[90%] rounded-xl px-4 py-2 text-center font-mono text-xs"
          style={{ background: "rgba(255,180,84,0.08)", color: "var(--amber)", border: "1px solid rgba(255,180,84,0.25)" }}
        >
          {msg.content}
        </div>
      </div>
    );
  }

  // History bubbles carry reconstructed toolCalls (from the persisted store);
  // live bubbles carry ToolEvent[] via `tools`. Show whichever exists.
  const hasChain = !isUser && (msg.toolCalls?.length || (tools && tools.length > 0));

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className="max-w-[88%] min-w-0 rounded-2xl px-4 py-2.5 text-sm leading-relaxed"
        style={
          isUser
            ? { background: "linear-gradient(135deg, var(--accent), var(--accent-2))", color: "#fff" }
            : { background: "color-mix(in srgb, var(--bg) 60%, transparent)", color: "var(--text)", border: "1px solid var(--card-border)" }
        }
      >
        {!isUser && msg.reasoning && (
          <ReasoningBlock text={msg.reasoning} mode={settings.reasoning} />
        )}
        {!isUser && msg.toolCalls && msg.toolCalls.length > 0 && (
          <div className="mb-2">
            <HistoryToolCalls calls={msg.toolCalls} mode={settings.tools} />
          </div>
        )}
        {!isUser && tools && tools.length > 0 && (
          <div className="mb-2">
            <ToolCallStack tools={tools} mode={settings.tools} />
          </div>
        )}
        <div className="whitespace-pre-wrap break-words">
          <MarkdownLite text={msg.content} />
        </div>
        {!isUser && msg.stats && (msg.stats.model || msg.stats.tokens !== undefined) && (
          <div
            className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[9px]"
            style={{ color: "var(--text-faint)" }}
          >
            {msg.stats.model && <span>{msg.stats.model}</span>}
            {msg.stats.tokens !== undefined && msg.stats.tokens > 0 && (
              <span>{msg.stats.tokens.toLocaleString()} tokens</span>
            )}
          </div>
        )}
        {hasChain && (
          <button
            onClick={() => setChainOpen(true)}
            className="mt-2 flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[10px] font-semibold"
            style={{ borderColor: "var(--card-border)", color: "var(--text-faint)" }}
          >
            <Maximize2 className="h-3 w-3" />
            Full chain — {msg.toolCalls?.length ?? tools?.length ?? 0} tool call{((msg.toolCalls?.length ?? tools?.length ?? 0) === 1) ? "" : "s"}
          </button>
        )}
      </div>
      {chainOpen && (
        <ChainView
          reasoning={msg.reasoning ?? ""}
          toolCalls={msg.toolCalls ?? []}
          liveTools={tools ?? []}
          content={msg.content}
          onClose={() => setChainOpen(false)}
        />
      )}
    </div>
  );
});

// Compact chips for tool calls reconstructed from history.
function HistoryToolCalls({ calls, mode }: { calls: ToolCallInfo[]; mode: ChatSettings["tools"] }) {
  if (mode === "count") {
    return (
      <div className="flex items-center gap-1.5 text-xs" style={{ color: "var(--text-faint)" }}>
        <Wrench className="h-3.5 w-3.5" />
        {calls.length} tool call{calls.length === 1 ? "" : "s"}
        {calls.filter((c) => c.error).length > 0 && (
          <span style={{ color: "var(--red)" }}>· {calls.filter((c) => c.error).length} failed</span>
        )}
      </div>
    );
  }
  return (
    <div className="flex max-w-full flex-col gap-1">
      {calls.map((c, i) => (
        <div
          key={`${c.name}-${i}`}
          className="flex max-w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs"
          style={{
            borderColor: c.error ? "color-mix(in srgb, var(--red) 40%, transparent)" : "var(--card-border)",
            background: c.error ? "rgba(255,92,92,0.08)" : "color-mix(in srgb, var(--bg) 55%, transparent)",
            color: c.error ? "var(--red)" : "var(--text-dim)",
          }}
        >
          {c.error ? (
            <XCircle className="h-3.5 w-3.5 shrink-0" />
          ) : c.result !== undefined ? (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--green)" }} />
          ) : (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" style={{ color: "var(--accent)" }} />
          )}
          <span className="truncate">{c.name.replace(/_/g, " ")}</span>
          {c.result !== undefined && (
            <span className="ml-auto shrink-0 font-mono text-[10px] opacity-70">
              {c.result.length > 0 ? `${c.result.length} chars` : "empty"}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
