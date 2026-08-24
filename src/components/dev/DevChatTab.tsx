"use client";

import {
  AlertCircle,
  Loader2,
  MessageSquare,
  RefreshCw,
  Send,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { MessageBubble } from "@/components/chat/MessageBubble";
import type {
  ChatMsg,
  ChatSettings,
  ToolCallInfo,
  ToolEvent,
} from "@/lib/chat-types";

export type Project = {
  name: string;
  source: "vercel" | "github" | "both";
  vercelId: string | null;
  framework: string | null;
  repo: string | null;
  private: boolean | null;
  description: string | null;
  defaultBranch: string | null;
  pushedAt: string | null;
  updatedAt: string | null;
  url: string | null;
};

type DevMessage = ChatMsg & { id: string };

type RawMessage = {
  id?: unknown;
  role?: unknown;
  content?: unknown;
  reasoning?: unknown;
  reasoning_content?: unknown;
  tool_call_id?: unknown;
  tool_calls?: unknown;
  tool_name?: unknown;
};

type LiveReply = {
  message: DevMessage;
  tools: ToolEvent[];
  phase: string;
};

type FailedTurn = {
  text: string;
  userMessageId: string;
};

const CHAT_SETTINGS: ChatSettings = {
  reasoning: "full",
  tools: "summary",
  showStats: false,
  autoScroll: true,
};

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function errorText(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const record = payload as Record<string, unknown>;
  if (typeof record.error === "string") return record.error;
  if (record.error && typeof record.error === "object") {
    const nested = record.error as Record<string, unknown>;
    if (typeof nested.message === "string") return nested.message;
  }
  return fallback;
}

function parseToolCalls(
  rawValue: unknown,
  fallbackName: string,
  results: Map<string, { result: string; error: boolean }>
): ToolCallInfo[] | undefined {
  if (!rawValue || rawValue === "None") return undefined;

  let value = rawValue;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(value)) return undefined;

  const calls = value.map((item): ToolCallInfo => {
    const call =
      item && typeof item === "object"
        ? (item as Record<string, unknown>)
        : {};
    const fn =
      call.function && typeof call.function === "object"
        ? (call.function as Record<string, unknown>)
        : {};
    const id = stringValue(call.id) || stringValue(call.call_id);
    const args = fn.arguments;
    const result = id ? results.get(id) : undefined;

    return {
      id: id || undefined,
      name: stringValue(fn.name) || fallbackName || "tool",
      args:
        typeof args === "string"
          ? args
          : args === undefined
            ? undefined
            : JSON.stringify(args),
      result: result?.result,
      error: result?.error,
      durationMs: result ? undefined : 0,
    };
  });

  return calls.length > 0 ? calls : undefined;
}

function normalizeHistory(rows: unknown[]): DevMessage[] {
  const rawRows = rows.filter(
    (row): row is RawMessage => Boolean(row) && typeof row === "object"
  );
  const toolResults = new Map<string, { result: string; error: boolean }>();

  for (const row of rawRows) {
    if (row.role !== "tool") continue;
    const id = stringValue(row.tool_call_id);
    if (!id) continue;

    let result = stringValue(row.content);
    let failed = false;
    try {
      const parsed = JSON.parse(result) as unknown;
      if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        failed = Boolean(record.error);
        const unwrapped = record.output ?? record.result;
        if (unwrapped !== undefined) {
          result =
            typeof unwrapped === "string"
              ? unwrapped
              : JSON.stringify(unwrapped);
        }
      }
    } catch {
      // Raw tool output is already displayable.
    }
    toolResults.set(id, { result: result.slice(0, 2000), error: failed });
  }

  const messages: DevMessage[] = [];
  let pendingAssistant: DevMessage | null = null;

  const flushAssistant = () => {
    if (pendingAssistant) messages.push(pendingAssistant);
    pendingAssistant = null;
  };

  rawRows.forEach((row, index) => {
    if (row.role !== "user" && row.role !== "assistant" && row.role !== "system") {
      return;
    }

    const role = row.role;
    const reasoning =
      stringValue(row.reasoning_content) || stringValue(row.reasoning) || null;
    const toolCalls =
      role === "assistant"
        ? parseToolCalls(
            row.tool_calls,
            stringValue(row.tool_name),
            toolResults
          )
        : undefined;
    const message: DevMessage = {
      id: stringValue(row.id) || `history-${index}`,
      role,
      content: stringValue(row.content),
      reasoning,
      toolCalls,
    };

    if (role === "assistant") {
      if (!pendingAssistant) {
        pendingAssistant = message;
        return;
      }
      if (message.content) {
        pendingAssistant.content += `${pendingAssistant.content ? "\n\n" : ""}${message.content}`;
      }
      if (message.reasoning) {
        pendingAssistant.reasoning = pendingAssistant.reasoning
          ? `${pendingAssistant.reasoning}\n${message.reasoning}`
          : message.reasoning;
      }
      if (message.toolCalls?.length) {
        pendingAssistant.toolCalls = [
          ...(pendingAssistant.toolCalls ?? []),
          ...message.toolCalls,
        ];
      }
      return;
    }

    flushAssistant();
    messages.push(message);
  });

  flushAssistant();
  return messages;
}

function payloadString(
  payload: Record<string, unknown>,
  key: string
): string {
  return typeof payload[key] === "string" ? payload[key] : "";
}

function toolArgs(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}

export default function DevChatTab({ project }: { project: Project }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DevMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [failedTurn, setFailedTurn] = useState<FailedTurn | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [live, setLive] = useState<LiveReply | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const streamAbortRef = useRef<AbortController | null>(null);

  const endpoint = `/api/dev/projects/${encodeURIComponent(project.name)}/chat`;

  const loadConversation = useCallback(
    async (signal?: AbortSignal) => {
      // Yield once so effect-driven loads never synchronously cascade state.
      await Promise.resolve();
      if (signal?.aborted) return;
      setLoading(true);
      setLoadError(null);
      setSessionId(null);
      setMessages([]);
      setInput("");
      setLive(null);
      setStreamError(null);
      setFailedTurn(null);
      try {
        const response = await fetch(endpoint, {
          cache: "no-store",
          signal,
        });
        const payload = (await response.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        if (!response.ok) {
          throw new Error(
            errorText(payload, `Conversation failed to load (${response.status})`)
          );
        }

        const session =
          payload.session && typeof payload.session === "object"
            ? (payload.session as Record<string, unknown>)
            : null;
        setSessionId(session ? stringValue(session.id) || null : null);
        setMessages(
          normalizeHistory(Array.isArray(payload.messages) ? payload.messages : [])
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [endpoint]
  );

  useEffect(() => {
    const controller = new AbortController();
    streamAbortRef.current?.abort();
    const timer = window.setTimeout(() => {
      void loadConversation(controller.signal);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadConversation]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, live, streamError]);

  useEffect(
    () => () => {
      streamAbortRef.current?.abort();
    },
    []
  );

  const sendMessage = useCallback(
    async (rawText: string, appendUser: boolean) => {
      const text = rawText.trim();
      if (!text || streaming) return;

      const userMessageId = appendUser
        ? crypto.randomUUID()
        : failedTurn?.userMessageId ?? crypto.randomUUID();
      const cleanHistory =
        appendUser && failedTurn
          ? messages.filter((message) => message.id !== failedTurn.userMessageId)
          : messages;
      const outboundMessages = appendUser
        ? [
            ...cleanHistory,
            { id: userMessageId, role: "user" as const, content: text },
          ]
        : cleanHistory;

      setMessages(outboundMessages);
      setInput("");
      setStreamError(null);
      setFailedTurn(null);
      setStreaming(true);
      setLive({
        message: {
          id: `live-${crypto.randomUUID()}`,
          role: "assistant",
          content: "",
          reasoning: null,
        },
        tools: [],
        phase: "Initializing…",
      });

      let activeSessionId = sessionId;
      const controller = new AbortController();
      streamAbortRef.current = controller;

      try {
        if (!activeSessionId) {
          const createResponse = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
            signal: controller.signal,
          });
          const createPayload = (await createResponse
            .json()
            .catch(() => ({}))) as Record<string, unknown>;
          const createdId = stringValue(createPayload.sessionId);
          if (!createResponse.ok || !createdId) {
            throw new Error(
              errorText(
                createPayload,
                `Conversation could not be created (${createResponse.status})`
              )
            );
          }
          activeSessionId = createdId;
          setSessionId(createdId);
        }

        const response = await fetch(`${endpoint}/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: activeSessionId,
            message: text,
            messages: outboundMessages.map(({ role, content }) => ({
              role,
              content,
            })),
          }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          const payload = await response.json().catch(() => null);
          throw new Error(
            errorText(payload, `Chat stream failed (${response.status})`)
          );
        }

        const decoder = new TextDecoder();
        const reader = response.body.getReader();
        let buffer = "";
        let content = "";
        let reasoning = "";
        let tools: ToolEvent[] = [];
        let phase = "Thinking…";

        const publish = () => {
          setLive({
            message: {
              id: "live-assistant",
              role: "assistant",
              content,
              reasoning: reasoning || null,
            },
            tools: [...tools],
            phase,
          });
        };

        const startTool = (
          name: string,
          preview?: string,
          args?: string
        ) => {
          const existingIndex = tools.findIndex(
            (tool) => tool.name === name && tool.durationMs === undefined
          );
          if (existingIndex >= 0) {
            tools = tools.map((tool, index) =>
              index === existingIndex
                ? {
                    ...tool,
                    preview: preview || tool.preview,
                    args: args || tool.args,
                  }
                : tool
            );
          } else {
            tools = [
              ...tools,
              { name, startedAt: Date.now(), preview, args },
            ];
          }
          phase = `Using ${name.replaceAll("_", " ")}…`;
          publish();
        };

        const completeTool = (name: string, failed: boolean, duration?: number) => {
          const existingIndex = tools.findIndex(
            (tool) => tool.name === name && tool.durationMs === undefined
          );
          if (existingIndex < 0) {
            tools = [
              ...tools,
              {
                name,
                startedAt: Date.now(),
                durationMs: duration ?? 0,
                error: failed,
              },
            ];
          } else {
            tools = tools.map((tool, index) =>
              index === existingIndex
                ? {
                    ...tool,
                    durationMs:
                      duration ?? Math.max(0, Date.now() - tool.startedAt),
                    error: failed,
                  }
                : tool
            );
          }
          phase = "Working…";
          publish();
        };

        const handleFrame = (frame: string) => {
          const lines = frame.split(/\r?\n/);
          const eventLine = lines.find((line) => line.startsWith("event:"));
          const dataLines = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart());
          if (dataLines.length === 0) return;

          let payload: Record<string, unknown>;
          try {
            const parsed = JSON.parse(dataLines.join("\n")) as unknown;
            if (!parsed || typeof parsed !== "object") return;
            payload = parsed as Record<string, unknown>;
          } catch {
            return;
          }

          const event =
            payloadString(payload, "event") ||
            eventLine?.slice(6).trim() ||
            "message";

          switch (event) {
            case "run.started":
              phase = "Initializing…";
              publish();
              break;
            case "message.started":
              phase = "Thinking…";
              publish();
              break;
            case "assistant.delta": {
              const delta = payloadString(payload, "delta");
              if (delta) content += delta;
              phase = "Responding…";
              publish();
              break;
            }
            case "tool.progress": {
              const name = payloadString(payload, "tool_name") || "_thinking";
              const delta = payloadString(payload, "delta");
              if (name === "_thinking") {
                if (delta) reasoning += delta;
                phase = "Thinking…";
                publish();
              } else {
                startTool(
                  name,
                  payloadString(payload, "preview") || undefined,
                  toolArgs(payload.args)
                );
              }
              break;
            }
            case "tool.started": {
              const name = payloadString(payload, "tool_name") || "tool";
              if (name !== "_thinking") {
                startTool(
                  name,
                  payloadString(payload, "preview") || undefined,
                  toolArgs(payload.args)
                );
              }
              break;
            }
            case "tool.completed": {
              const seconds =
                typeof payload.duration === "number" ? payload.duration : undefined;
              completeTool(
                payloadString(payload, "tool_name") || "tool",
                Boolean(payload.is_error),
                seconds === undefined ? undefined : seconds * 1000
              );
              break;
            }
            case "tool.failed":
              completeTool(
                payloadString(payload, "tool_name") || "tool",
                true
              );
              break;
            case "assistant.completed": {
              const finalContent = payloadString(payload, "content");
              if (finalContent) content = finalContent;
              phase = "Finishing…";
              publish();
              break;
            }
            case "run.completed":
            case "done":
              phase = "Done";
              publish();
              break;
            case "error":
              throw new Error(
                payloadString(payload, "error") ||
                  payloadString(payload, "message") ||
                  "Stream error"
              );
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? "";
          frames.forEach(handleFrame);
        }
        buffer += decoder.decode();
        if (buffer.trim()) handleFrame(buffer);

        if (!content && !reasoning && tools.length === 0) {
          throw new Error("The stream ended before the orchestrator replied");
        }

        const completedAt = Date.now();
        tools = tools.map((tool) =>
          tool.durationMs === undefined
            ? {
                ...tool,
                durationMs: Math.max(0, completedAt - tool.startedAt),
                interrupted: true,
              }
            : tool
        );
        const finalMessage: DevMessage = {
          id: `assistant-${crypto.randomUUID()}`,
          role: "assistant",
          content,
          reasoning: reasoning || null,
          toolCalls:
            tools.length > 0
              ? tools.map((tool) => ({
                  name: tool.name,
                  args: tool.args,
                  error: tool.error,
                  durationMs: tool.durationMs,
                  interrupted: tool.interrupted,
                }))
              : undefined,
        };
        setMessages([...outboundMessages, finalMessage]);
        setLive(null);
        setFailedTurn(null);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLive(null);
        setStreamError(error instanceof Error ? error.message : String(error));
        setFailedTurn({ text, userMessageId });
      } finally {
        if (streamAbortRef.current === controller) {
          streamAbortRef.current = null;
        }
        setStreaming(false);
      }
    },
    [endpoint, failedTurn, messages, sessionId, streaming]
  );

  const submit = () => {
    void sendMessage(input, true);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <section className="card flex h-[560px] flex-col overflow-hidden">
      <header
        className="flex items-start gap-3 border-b px-5 py-4"
        style={{ borderColor: "var(--card-border)" }}
      >
        <MessageSquare
          className="mt-0.5 h-5 w-5 shrink-0"
          style={{ color: "var(--accent)" }}
        />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">
            Conversation with your orchestrator — persistent per project
          </h2>
          <p className="mt-0.5 truncate text-xs" style={{ color: "var(--text-dim)" }}>
            {project.repo ?? `Mr-Akhil12/${project.name}`} · session {`[dev:${project.name}]`}
          </p>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {loading ? (
          <div
            className="flex h-full items-center justify-center gap-2 text-sm"
            style={{ color: "var(--text-faint)" }}
          >
            <Loader2 className="h-4 w-4 animate-spin" /> Loading conversation…
          </div>
        ) : loadError ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <AlertCircle className="h-5 w-5" style={{ color: "var(--red)" }} />
            <p className="max-w-md text-sm" style={{ color: "var(--red)" }}>
              {loadError}
            </p>
            <button
              type="button"
              onClick={() => void loadConversation()}
              className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold"
              style={{ borderColor: "var(--card-border)", color: "var(--text-dim)" }}
            >
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </button>
          </div>
        ) : (
          <>
            {messages.length === 0 && !live && !streamError && (
              <div
                className="flex h-full items-center justify-center text-center text-sm"
                style={{ color: "var(--text-faint)" }}
              >
                Start a conversation about {project.name}
              </div>
            )}

            {messages.map((message) => (
              <MessageBubble
                key={message.id}
                msg={message}
                settings={CHAT_SETTINGS}
              />
            ))}

            {live && (
              <div className="space-y-2" aria-live="polite">
                {(live.message.content || live.message.reasoning || live.tools.length > 0) && (
                  <MessageBubble
                    msg={live.message}
                    settings={CHAT_SETTINGS}
                    tools={live.tools}
                  />
                )}
                <div
                  className="flex items-center gap-2 pl-1 text-xs"
                  style={{ color: "var(--text-faint)" }}
                >
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> {live.phase}
                </div>
              </div>
            )}

            {streamError && (
              <div className="flex justify-start" role="alert">
                <div
                  className="max-w-[88%] rounded-2xl border px-4 py-3 text-sm"
                  style={{
                    borderColor: "color-mix(in srgb, var(--red) 45%, transparent)",
                    background: "color-mix(in srgb, var(--red) 8%, transparent)",
                    color: "var(--red)",
                  }}
                >
                  <div className="flex items-start gap-2">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{streamError}</span>
                  </div>
                  {failedTurn && (
                    <button
                      type="button"
                      onClick={() => void sendMessage(failedTurn.text, false)}
                      disabled={streaming}
                      className="mt-2 inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold disabled:opacity-50"
                      style={{ borderColor: "currentColor" }}
                    >
                      <RefreshCw className="h-3.5 w-3.5" /> Retry
                    </button>
                  )}
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </>
        )}
      </div>

      <div
        className="border-t p-3"
        style={{ borderColor: "var(--card-border)" }}
      >
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            disabled={streaming || loading || Boolean(loadError)}
            rows={1}
            placeholder={`Message your ${project.name} orchestrator…`}
            className="max-h-28 min-h-10 flex-1 resize-none rounded-xl border bg-transparent px-3 py-2.5 text-sm outline-none disabled:opacity-50"
            style={{
              borderColor: "var(--card-border)",
              color: "var(--text)",
            }}
          />
          <button
            type="button"
            onClick={submit}
            disabled={
              streaming || loading || Boolean(loadError) || !input.trim()
            }
            className="inline-flex h-10 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold disabled:opacity-50"
            style={{ background: "var(--accent)", color: "#fff" }}
          >
            {streaming ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            Send
          </button>
        </div>
        <p className="mt-1.5 px-1 text-[10px]" style={{ color: "var(--text-faint)" }}>
          Enter to send · Shift+Enter for a new line · history reloads whenever this tab opens
        </p>
      </div>
    </section>
  );
}
