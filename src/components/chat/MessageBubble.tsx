"use client";

// Message bubble with reasoning disclosure, tool-call chips and markdown-lite
// rendering. Reasoning display respects the user's setting.

import { useState } from "react";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import type { ChatSettings, ChatMsg, ToolEvent } from "@/lib/chat-types";
import { ToolCallStack } from "./ToolCalls";

/** Tiny markdown renderer: **bold**, `code`, ```fences```, *italic*, links. */
export function MarkdownLite({ text }: { text: string }) {
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
}

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

export function MessageBubble({
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
        {!isUser && tools && tools.length > 0 && (
          <div className="mb-2">
            <ToolCallStack tools={tools} mode={settings.tools} />
          </div>
        )}
        <div className="whitespace-pre-wrap break-words">
          <MarkdownLite text={msg.content} />
        </div>
      </div>
    </div>
  );
}
