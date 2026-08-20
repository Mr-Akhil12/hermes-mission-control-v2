"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Send, Mic, MicOff, Volume2, MessageSquare, Plus, ChevronLeft, ChevronRight,
  Loader2, Trash2, Pencil, Square, CheckSquare, X, Maximize2, Minimize2, Bot,
} from "lucide-react";
import type { ChatMsg, ChatSettings, StreamEvent, ToolEvent, ChainSegment, RunStats, ToolCallInfo, ChatSegment } from "@/lib/chat-types";
import { useSessions } from "@/lib/use-sessions";
import { PROFILES, profileLabel } from "@/lib/profiles";
import { MessageBubble, MarkdownLite } from "@/components/chat/MessageBubble";
import { ChatSettingsButton, DEFAULT_SETTINGS, loadSettings } from "@/components/chat/ChatSettings";
import { Composer, type PendingAttachment } from "@/components/chat/Composer";
import { SlashAutocomplete } from "@/components/chat/SlashAutocomplete";
import { PhaseBanner, type RunPhase } from "@/components/chat/RunStatus";
import { MessageSkeleton, SessionListSkeleton } from "@/components/chat/Skeleton";
import { BrowserView } from "@/components/chat/BrowserView";
import { ChainView } from "@/components/chat/ChainView";
import { DEFAULT_MODEL as MODEL } from "@/lib/models";
import { dbg, toolSnap, liveSnap } from "@/lib/chat-debug";

type LiveState = {
  phase: RunPhase;
  reasoning: string;
  tools: ToolEvent[];
  // Ordered live chain: reasoning and tool calls interleaved in the exact
  // sequence they happened. The renderer walks this, so nothing ever
  // disappears when the phase flips between thinking/tools/streaming.
  chain: ChainSegment[];
  stats: RunStats | null;
  // tool call accounting for the current run
  toolCount: number;
  failedCount: number;
};

const IDLE_LIVE: LiveState = {
  phase: "idle",
  reasoning: "",
  tools: [],
  chain: [],
  stats: null,
  toolCount: 0,
  failedCount: 0,
};

// ── Module-scoped live-stream persistence ─────────────────────────────
// ChatPage unmounts when the user navigates to another tab (SPA route
// change). All the per-session stream state below lives at module scope so
// it SURVIVES navigation — the chain, tools, streamed text, and SSE seq
// counter are restored on return instead of reset, which is what makes
// "leave the chat and come back" keep the live UI intact (the user's core
// streaming complaint). A single active stream is tracked (single-user).
type ModuleLiveState = {
  live: LiveState;
  streamedText: string;
  busy: boolean;
  streamSession: string | null;
  lastSeq: number;
};

const moduleLive: Record<string, ModuleLiveState> = {};
const lastSeqState: Record<string, number> = {};
// Set when the final assistant message has been appended to the message list
// (assistant.completed). renderLiveContent reads this to stop rendering the
// live bubble — otherwise the same reasoning + content shows twice (final
// bubble + live bubble) between assistant.completed and run.completed.
const moduleFinalAppended: Record<string, boolean> = {};
// Per-session run generation. Incremented on every new send AND when the
// user switches INTO a session (selectSession/newConversation/profile switch).
// moduleFinalAppended must match the CURRENT generation to suppress the live
// bubble — a stale `true` from a previous run on this session must not hide a
// new run's live reasoning.
const moduleRunGen: Record<string, number> = {};

function bumpRunGen(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  moduleRunGen[sessionId] = (moduleRunGen[sessionId] ?? 0) + 1;
  moduleFinalAppended[sessionId] = false;
  dbg("gen", `bumpRunGen gen=${moduleRunGen[sessionId]} finalAppended=false`, { sessionId });
}

function isFinalAppendedForCurrentRun(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  const gen = moduleRunGen[sessionId];
  // No generation recorded yet (nothing ran) → nothing appended.
  if (gen === undefined) return false;
  const v = moduleFinalAppended[sessionId] === true;
  dbg("gen", `isFinalAppended gen=${gen} finalAppended=${moduleFinalAppended[sessionId]} -> ${v}`, { sessionId });
  return v;
}

function getModuleLive(sessionId: string): ModuleLiveState {
  if (!moduleLive[sessionId]) {
    moduleLive[sessionId] = {
      live: { ...IDLE_LIVE },
      streamedText: "",
      busy: false,
      streamSession: null,
      lastSeq: 0,
    };
  }
  return moduleLive[sessionId];
}

function toolEventToRunTool(t: ToolEvent) {
  return t;
}

// Append a reasoning delta to the ordered chain: extend the LAST reasoning
// segment if the most recent segment is reasoning; otherwise start a new
// reasoning segment (after a tool call). This keeps reasoning and tools
// interleaved in exact sequence, never split into disappearing sections.
function appendReasoningToChain(chain: ChainSegment[], delta: string): ChainSegment[] {
  if (!delta) return chain;
  const last = chain[chain.length - 1];
  if (last && last.kind === "reasoning") {
    const copy = chain.slice(0, -1);
    copy.push({ kind: "reasoning", text: last.text + delta });
    return copy;
  }
  return [...chain, { kind: "reasoning", text: delta }];
}

// Settle a tool that never received a completion frame: mark it INTERRUPTED
// (muted state) instead of fabricating error:false — a dropped tool.failed
// frame must not render as a green checkmark. A tool that DID get a real
// completion keeps its error bit.
function settleTool(t: ToolEvent, now: number): ToolEvent {
  if (t.durationMs !== undefined) return t;
  const s = {
    ...t,
    durationMs: Math.max(1, now - (t.startedAt ?? now)),
    interrupted: t.error === undefined,
  };
  dbg("settle", `settleTool '${t.name}' durationMs=${s.durationMs} interrupted=${s.interrupted}`, toolSnap(s));
  return s;
}

function settleToolInChain(c: ChainSegment, now: number): ChainSegment {
  if (c.kind === "reasoning") return c;
  return { ...c, tool: settleTool(c.tool, now) };
}

// Settle a live snapshot once a run is confirmed finished: every tool with
// no duration (still showing the spinner) gets a completion time, and the
// phase flips to "done" so returning to the chat NEVER shows infinite
// loading tools. The ordered chain is preserved (tools marked completed or
// interrupted — never fabricated success).
function settleLiveState(live: LiveState, now = Date.now()): LiveState {
  const tools = live.tools.map((t) => settleTool(t, now));
  const chain = live.chain.map((c) => settleToolInChain(c, now));
  const next = { ...live, tools, chain, phase: "done" as const };
  dbg("settle", "settleLiveState -> done", { before: liveSnap(live), after: liveSnap(next) });
  return next;
}

export default function ChatPage() {
  const [error, setError] = useState<string | null>(null);
  const {
    sessions,
    sessionsLoading,
    setSessionsLoading,
    activeId,
    setActiveId,
    sessionFilter,
    setSessionFilter,
    profile,
    setProfile,
    loadSessions,
  } = useSessions({ setError });
  const [messagesLoading, setMessagesLoading] = useState(false);
  // Live mirror of the currently-viewed session so the send() finally block
  // can tell whether the user navigated away mid-run (the closure's activeId
  // goes stale).
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [chainOpen, setChainOpen] = useState(false);
  const [live, setLive] = useState<LiveState>(IDLE_LIVE);
  const [lastStats, setLastStats] = useState<RunStats | null>(null);
  const [settings, setSettings] = useState<ChatSettings>(DEFAULT_SETTINGS);
  const [streamedText, setStreamedText] = useState("");
  const [elapsedSec, setElapsedSec] = useState(0);
  const [retryTarget, setRetryTarget] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const reasoningRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const streamAbort = useRef<AbortController | null>(null);
  // Which session the current SSE stream belongs to — so switching away
  // doesn't kill a background run, and switching back can restore its state.
  const streamSessionRef = useRef<string | null>(null);
  // Per-session live state, preserved across switches so an active stream
  // keeps rendering when you come back to its conversation.
  const liveBySessionRef = useRef<Record<string, { live: LiveState; streamedText: string }>>({});
  const liveRef = useRef(live);
  liveRef.current = live;
  // Synchronous busy flag — the `send` closure's `busy` goes stale during
  // the finally-block queue flush; this ref always has the latest value.
  const busyRef = useRef(false);
  busyRef.current = busy;
  // Per-conversation unsent draft text, preserved when navigating between chats.
  const draftsRef = useRef<Record<string, string>>({});
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);

  // Load display settings once.
  useEffect(() => {
    setSettings(loadSettings());
  }, []);

  // Restore the unsent draft for the newly active conversation.
  useEffect(() => {
    if (activeId) setInput(draftsRef.current[activeId] ?? "");
  }, [activeId]);

  // Restore the module-scoped live stream state when remounting this page
  // (after navigating to another tab). If the run is still going, reattach
  // picks up from the saved seq; if it finished, we show the settled state.
  // NOTE: busy is intentionally NOT restored blindly — a stale `true` from a
  // finished run would block the reattach settle below and leave the tools
  // spinning forever. reattachRun() re-establishes busy only when the events
  // stream proves the run is actually live.
  useEffect(() => {
    if (!activeId) return;
    const saved = moduleLive[activeId];
    if (saved) {
      if (saved.live.phase !== "idle") {
        setLive(saved.live);
        setStreamedText(saved.streamedText);
        setLastStats(saved.live.stats);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const loadMessages = useCallback(async (id: string) => {
    setMessagesLoading(true);
    try {
      const profileQs = profile ? `?profile=${encodeURIComponent(profile)}` : "";
      const res = await fetch(`/api/chat/sessions/${id}/messages${profileQs}`, { cache: "no-store" });
      const data = await res.json();
      const list = data?.data ?? [];
      dbg("loadMessages", `GET /messages rows=${list.length} http=${res.status} profile=${profile ?? "default"}`, { sessionId: id });
      const modelName = MODEL;
      // The Hermes API persists each assistant fragment as its own row —
      // thinking text between tool calls, empty frames, and the final reply.
      // Live view shows one continuous reply; history must too. Merge
      // consecutive assistant rows into a single bubble (tool rows are
      // dropped anyway), so a past conversation renders exactly like the
      // current one: one message per turn.
      const msgs: ChatMsg[] = [];
      let pending: ChatMsg | null = null;
      // OR of interruption evidence across merged assistant rows (the
      // persisted row's finish_reason is authoritative for "this turn was
      // stopped"). A MISSING result row alone is NOT evidence of
      // interruption — tool_call_id matching can fail for successfully
      // completed tools (quoted/wrapped ids), so we must not mark those
      // interrupted.
      let pendingInterrupted = false;
      // Tool results keyed by tool_call_id so we can attach them to the
      // assistant's tool_calls and rebuild the full chain.
      const toolResults = new Map<string, { result: string; error: boolean }>();
      for (const m of list) {
        if (m.role === "tool") {
          const callId = m.tool_call_id;
          if (callId) {
            let result = typeof m.content === "string" ? m.content : "";
            let error = false;
            try {
              const parsed = JSON.parse(result);
              if (parsed && typeof parsed === "object") {
                if (parsed.error) error = true;
                if (parsed.output !== undefined) result = typeof parsed.output === "string" ? parsed.output : JSON.stringify(parsed.output);
                else if (parsed.result !== undefined) result = typeof parsed.result === "string" ? parsed.result : JSON.stringify(parsed.result);
              }
            } catch {
              /* keep raw content */
            }
            toolResults.set(callId, { result: result.slice(0, 2000), error });
          }
          continue;
        }
        if (!["user", "assistant", "system"].includes(m.role)) continue;
        // Parse the assistant's tool_calls (stored as a JSON string).
        let toolCalls: ToolCallInfo[] | undefined;
        if (m.role === "assistant" && m.tool_calls && m.tool_calls !== "None") {
          try {
            const raw = typeof m.tool_calls === "string" ? JSON.parse(m.tool_calls) : m.tool_calls;
            if (Array.isArray(raw)) {
              toolCalls = raw.map((tc: any) => {
                const fn = tc?.function ?? {};
                const callId = tc?.id ?? tc?.call_id ?? "";
                const res = callId ? toolResults.get(callId) : undefined;
                return {
                  id: callId,
                  name: fn?.name ?? m.tool_name ?? "tool",
                  args: typeof fn?.arguments === "string" ? fn.arguments : JSON.stringify(fn?.arguments ?? {}),
                  result: res?.result,
                  error: res?.error,
                  // A completed run's tool call with no matched result row is
                  // still COMPLETED (the call happened; the payload just
                  // wasn't persisted or the id didn't match). Never render a
                  // spinner for it — mark it done with unknown duration.
                  // Interrupted runs still stamp interrupted at flush time and
                  // take precedence in the icon chain.
                  durationMs: res ? undefined : 0,
                  // interrupted is stamped at flush time from REAL evidence
                  // (finish_reason indicating the turn was stopped) — never
                  // from a missing result row alone, because tool_call_id
                  // matching can fail for successfully completed tools.
                };
              });
            }
          } catch {
            toolCalls = undefined;
          }
        }
        const msg: ChatMsg = {
          role: m.role,
          content: m.content ?? "",
          reasoning: m.reasoning_content ?? m.reasoning ?? null,
          toolCalls,
          // Per-message stats: the persisted row's token_count + the session
          // model (from the session list) — shown at the end of the bubble.
          stats:
            m.role === "assistant"
              ? {
                  model: modelName,
                  tokens: typeof m.token_count === "number" ? m.token_count : undefined,
                }
              : null,
        };
        if (msg.role === "assistant") {
          // REAL interruption evidence: the persisted row's finish_reason.
          // "length", "stop", "tool_calls", "content_filter" are normal
          // completions; anything indicating the turn was halted (or an
          // explicit interrupted flag from the API) marks the turn stopped.
          const fr = String(m.finish_reason ?? "").toLowerCase();
          const rowInterrupted =
            fr === "interrupted" ||
            fr === "cancelled" ||
            fr === "abort" ||
            fr === "halted" ||
            fr === "safety" ||
            (m as any).interrupted === true ||
            (m as any).is_interrupted === true;
          if (rowInterrupted) pendingInterrupted = true;
          if (pending) {
            pending.content += (pending.content && msg.content ? "\n\n" : "") + msg.content;
            if (msg.reasoning) {
              pending.reasoning = pending.reasoning ? `${pending.reasoning}\n${msg.reasoning}` : msg.reasoning;
              // Preserve the ORDERED turn structure: append a reasoning
              // segment so history renders reasoning → tool → reasoning →
              // tool → answer exactly like the live chain. Merge adjacent
              // reasoning segments (a continuous thinking stream is often
              // persisted across several assistant rows) so history shows
              // ONE reasoning block per thinking phase, not N fragments.
              const segs = pending.segments ?? [];
              const lastSeg = segs[segs.length - 1];
              if (lastSeg && lastSeg.kind === "reasoning") {
                pending.segments = [...segs.slice(0, -1), { kind: "reasoning" as const, text: lastSeg.text + "\n" + msg.reasoning }];
              } else {
                pending.segments = [...segs, { kind: "reasoning" as const, text: msg.reasoning }];
              }
            }
            if (msg.toolCalls?.length) {
              pending.toolCalls = [...(pending.toolCalls ?? []), ...msg.toolCalls];
              // Merge adjacent tool segments too — a burst of tool calls in
              // one phase renders as one segment, matching the live chain.
              const segs = pending.segments ?? [];
              const lastSeg = segs[segs.length - 1];
              if (lastSeg && lastSeg.kind === "tools") {
                pending.segments = [...segs.slice(0, -1), { kind: "tools" as const, calls: [...lastSeg.calls, ...msg.toolCalls] }];
              } else {
                pending.segments = [...segs, { kind: "tools" as const, calls: msg.toolCalls }];
              }
            }
          } else {
            pending = {
              ...msg,
              segments:
                msg.reasoning || msg.toolCalls?.length
                  ? [
                      ...(msg.reasoning ? [{ kind: "reasoning" as const, text: msg.reasoning }] : []),
                      ...(msg.toolCalls?.length ? [{ kind: "tools" as const, calls: msg.toolCalls }] : []),
                    ]
                  : undefined,
            };
          }
        } else {
          if (pending) {
            // Stamp interrupted from REAL evidence only (finish_reason said
            // the turn was stopped). Never from a missing result row —
            // successful tools can lack a matched result due to id quoting.
            if (pendingInterrupted) {
              pending.toolCalls = pending.toolCalls?.map((c) =>
                c.result === undefined ? { ...c, interrupted: true } : c
              );
              pending.segments = pending.segments?.map((seg) =>
                seg.kind === "tools"
                  ? { ...seg, calls: seg.calls.map((c) => (c.result === undefined ? { ...c, interrupted: true } : c)) }
                  : seg
              );
            }
            msgs.push(pending);
            pending = null;
            pendingInterrupted = false;
          }
          msgs.push(msg);
        }
      }
      if (pending) {
        if (pendingInterrupted) {
          pending.toolCalls = pending.toolCalls?.map((c) =>
            c.result === undefined ? { ...c, interrupted: true } : c
          );
          pending.segments = pending.segments?.map((seg) =>
            seg.kind === "tools"
              ? { ...seg, calls: seg.calls.map((c) => (c.result === undefined ? { ...c, interrupted: true } : c)) }
              : seg
          );
        }
        msgs.push(pending);
      }
      setMessages(msgs);
      dbg("loadMessages", `merged rows=${list.length} -> msgs=${msgs.length} toolResults=${toolResults.size}`, {
        sessionId: id,
        assistantMsgs: msgs.filter((m) => m.role === "assistant").length,
        toolMsgs: msgs.filter((m) => m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0).length,
      });
    } catch (e) {
      dbg("loadMessages", `FAILED ${e instanceof Error ? e.message : e}`, { sessionId: id });
      setError(`Failed to load messages: ${e instanceof Error ? e.message : e}`);
    } finally {
      setMessagesLoading(false);
    }
  }, [profile]);

  useEffect(() => {
    const resumeId = new URLSearchParams(window.location.search).get("resume");
    loadSessions(resumeId ? "all" : undefined).then((list) => {
      // If arriving via a Resume link (e.g. from /sessions), open that exact
      // session instead of the default most-recent one. Load with source=all
      // so cron/subagent sessions (not in the dashboard filter) resolve too.
      const target = resumeId ? list.find((s) => s.id === resumeId) : undefined;
      if (target) {
        setActiveId(target.id);
        loadMessages(target.id);
      } else if (list.length > 0) {
        setActiveId(list[0].id);
        loadMessages(list[0].id);
      } else {
        setMessagesLoading(false);
      }
    });
  }, [loadSessions, loadMessages]);

  // Poll the session list every 15s so the "Working…" dots on active
  // conversations stay live — including sessions running in the background
  // (other devices, cron, dispatch) that this tab didn't start.
  useEffect(() => {
    const t = setInterval(() => {
      loadSessions();
    }, 15_000);
    return () => clearInterval(t);
  }, [loadSessions]);

  // Live elapsed timer — ticks every second while a run is active so the UI
  // always shows progress, even during quiet tool calls / model thinking.
  useEffect(() => {
    if (!busy) return;
    setElapsedSec(0);
    const started = Date.now();
    const t = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [busy]);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: settings.autoScroll ? "smooth" : "auto" });
  }, [settings.autoScroll]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, busy, live, streamedText, scrollToBottom]);

  // Keep the reasoning stream pinned to the bottom as it grows — the box is
  // height-capped and scrolls internally, so it must follow the newest text
  // instead of staying at the top.
  useEffect(() => {
    const el = reasoningRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [live.reasoning]);

  const newConversation = useCallback(async () => {
    // Lazy creation: don't POST a session yet — an empty conversation with
    // zero messages should never be saved. The session is created on the
    // first send() instead. Just clear the UI and arm the composer.
    setError(null);
    setLive(IDLE_LIVE);
    if (activeId) {
      draftsRef.current[activeId] = input;
      // Leaving this session for a fresh conversation — reset its run
      // generation so a future return to it isn't gated by a stale
      // moduleFinalAppended=true from the previous run.
      bumpRunGen(activeId);
    }
    setActiveId(null);
    setMessages([]);
    setStreamedText("");
    setInput("");
    setComposerExpanded(false);
    await loadSessions();
  }, [loadSessions, activeId, input]);

  // ── Slash command handling ──────────────────────────────────────────
  const sendRef = useRef<((text: string) => Promise<void>) | null>(null);

  const stopRun = useCallback(() => {
    streamAbort.current?.abort();
    setLive((prev) => ({
      ...prev,
      phase: "done",
      stats: {
        ...(prev.stats ?? { toolCount: 0, failedTools: 0, startedAt: Date.now() }),
        completedAt: Date.now(),
        durationMs: Date.now() - (prev.stats?.startedAt ?? Date.now()),
      },
    }));
    setBusy(false);
  }, []);

  const handleSlash = useCallback(
    async (raw: string): Promise<boolean> => {
      const trimmed = raw.trim();
      if (!trimmed.startsWith("/")) return false;
      const [cmdRaw, ...rest] = trimmed.slice(1).split(" ");
      const cmd = cmdRaw.toLowerCase();
      const arg = rest.join(" ").trim();

      switch (cmd) {
        case "new":
          await newConversation();
          return true;
        case "help": {
          const out = [
            "**Dashboard chat commands**",
            "",
            "`/new` — start a new conversation",
            "`/retry` — re-run the last message",
            "`/title <name>` — rename this conversation",
            "`/fork [name]` — branch this conversation",
            "`/model <name>` — switch the session model",
            "`/context` — context & token usage",
            "`/status` — session / model status",
            "`/version` — Hermes Agent version",
            "`/profile` — active profile",
            "`/whoami` — command access level",
            "`/help` — this list",
          ].join("\n");
          setMessages((m) => [...m, { role: "system", content: out }]);
          return true;
        }
        case "retry": {
          if (!retryTarget) {
            setMessages((m) => [...m, { role: "system", content: "Nothing to retry yet." }]);
            return true;
          }
          if (sendRef.current) await sendRef.current(retryTarget);
          return true;
        }
        case "title": {
          if (!activeId) return true;
          const name = arg || "Untitled";
          try {
            await fetch(`/api/chat/sessions/${activeId}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ title: name }),
            });
            setMessages((m) => [...m, { role: "system", content: `Renamed conversation to “${name}”.` }]);
            await loadSessions();
          } catch (e: any) {
            setError(`Rename failed: ${e?.message ?? e}`);
          }
          return true;
        }
        case "fork": {
          if (!activeId) return true;
          try {
            const res = await fetch(`/api/chat/sessions/${activeId}/fork`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(arg ? { title: arg } : {}),
              cache: "no-store",
            });
            const data = await res.json();
            const newId = data?.session?.id ?? data?.session_id ?? data?.id;
            if (!res.ok || !newId) {
              throw new Error(data?.error?.message ?? `fork failed (${res.status})`);
            }
            setActiveId(newId);
            setMessages([]);
            setStreamedText("");
            await loadSessions();
            await loadMessages(newId);
            setMessages((m) => [
              ...m,
              {
                role: "system",
                content: `Forked a new conversation${arg ? ` named “${arg}”` : ""}. Branch explores a fresh path; the original stays intact.`,
              },
            ]);
          } catch (e: any) {
            setError(`Fork failed: ${e?.message ?? e}`);
          }
          return true;
        }
        case "model": {
          if (!activeId) return true;
          if (!arg) {
            setMessages((m) => [...m, { role: "system", content: `Usage: \`/model <name>\` — e.g. \`/model ${MODEL}\`. Model locks the session (runtime verified server-side).` }]);
            return true;
          }
          try {
            const res = await fetch(`/api/chat/sessions/${activeId}/model`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: arg, require_model_lock: false }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data?.error?.message ?? `model lock failed (${res.status})`);
            const rt = data?.runtime;
            setMessages((m) => [
              ...m,
              {
                role: "system",
                content: `Model set: **${rt?.model ?? arg}**${rt?.provider ? ` via ${rt.provider}` : ""} (route: ${rt?.route_source ?? "global"}).`,
              },
            ]);
          } catch (e: any) {
            setError(`Model switch failed: ${e?.message ?? e}`);
          }
          return true;
        }
        case "context":
        case "status": {
          // Built client-side — the API has no registry executor for these,
          // but everything they'd show lives in state we already hold.
          const sid = activeId ?? "—";
          const sess = sessions.find((s) => s.id === sid);
          const lastStats = live.stats;
          const model = lastStats?.runtime?.model ?? MODEL;
          const provider = lastStats?.runtime?.provider ?? "";
          if (cmd === "status") {
            const out = [
              "**Status**",
              "",
              `Session: \`${sid.slice(0, 32)}${sid.length > 32 ? "…" : ""}\``,
              `Title: ${sess?.title || "(untitled)"}`,
              `Messages: ${sess?.message_count ?? messages.length}`,
              `Tool calls: ${sess?.tool_call_count ?? 0}`,
              `Model: ${model}${provider ? ` (${provider})` : ""}`,
              lastStats?.durationMs
                ? `Last run: ${(lastStats.durationMs / 1000).toFixed(1)}s · ${lastStats.toolCount} tools · ${lastStats.usage?.total_tokens?.toLocaleString() ?? "—"} tokens total`
                : "Last run: none yet this session",
            ].join("\n");
            setMessages((m) => [...m, { role: "system", content: out }]);
          } else {
            // REAL cumulative session usage from the sessions table (maintained
            // by Hermes on every API call) — the actual context that has been
            // sent to the model across the session's life, not the last run.
            const sess = sessions.find((s) => s.id === sid);
            const inp = sess?.input_tokens ?? lastStats?.usage?.input_tokens ?? 0;
            const out = sess?.output_tokens ?? lastStats?.usage?.output_tokens ?? 0;
            const tot = inp + out;
            const calls = sess?.api_call_count ?? 0;
            const cacheRead = sess?.cache_read_tokens ?? 0;
            const cacheWrite = sess?.cache_write_tokens ?? 0;
            const reasoning = sess?.reasoning_tokens ?? 0;
            const out2 = [
              "**Context**",
              "",
              `Messages in session: ${sess?.message_count ?? messages.length}`,
              `API calls: ${calls.toLocaleString()}`,
              `Input tokens (cumulative): ${inp.toLocaleString()}`,
              `Output tokens (cumulative): ${out.toLocaleString()}`,
              `Total (cumulative): ${tot.toLocaleString()}`,
              `Cache read: ${cacheRead.toLocaleString()} · write: ${cacheWrite.toLocaleString()}`,
              `Reasoning tokens: ${reasoning.toLocaleString()}`,
              "These are REAL cumulative session numbers — they add up over time and persist across runs.",
            ].join("\n");
            setMessages((m) => [...m, { role: "system", content: out2 }]);
          }
          return true;
        }
        case "whoami": {
          setMessages((m) => [
            ...m,
            { role: "system", content: "**Access**\n\nDashboard chat runs with the full host-user agent (yolo approved). Commands: admin.\n\nProfile: default · home: ~/.hermes" },
          ]);
          return true;
        }
        case "undo": {
          // Remove the last user+assistant exchange from the local view.
          setMessages((m) => {
            const copy = [...m];
            // pop trailing assistant/system, then the user message
            while (copy.length && copy[copy.length - 1].role !== "user") copy.pop();
            if (copy.length && copy[copy.length - 1].role === "user") copy.pop();
            return copy;
          });
          setMessages((m) => [...m, { role: "system", content: "Undid the last exchange (local view). The server transcript still has it — /new to start fresh." }]);
          return true;
        }
        case "stop": {
          stopRun();
          setMessages((m) => [...m, { role: "system", content: "Stopped the current run." }]);
          return true;
        }
        case "sessions": {
          const list = sessions.slice(0, 15).map((s, i) => `${i + 1}. \`${s.id.slice(0, 24)}${s.id.length > 24 ? "…" : ""}\` — ${s.title || s.last_message || "(untitled)"} (${s.message_count ?? 0} msgs)`).join("\n");
          setMessages((m) => [...m, { role: "system", content: `**Recent sessions**\n\n${list}\n\nUse \`/resume <id>\` to open one.` }]);
          return true;
        }
        case "resume": {
          if (!arg) {
            setMessages((m) => [...m, { role: "system", content: "Usage: `/resume <session-id>` — e.g. `/resume api_1786726486_fd3ed91e`. Run `/sessions` to list them." }]);
            return true;
          }
          const target = sessions.find((s) => s.id.startsWith(arg)) ?? sessions.find((s) => s.id === arg);
          if (!target) {
            setMessages((m) => [...m, { role: "system", content: `No session matching \`${arg}\`. Run \`/sessions\` to list.` }]);
            return true;
          }
          setActiveId(target.id);
          setMessages([]);
          setStreamedText("");
          setLive(IDLE_LIVE);
          await loadMessages(target.id);
          setMessages((m) => [...m, { role: "system", content: `Resumed \`${target.id.slice(0, 24)}…\` — ${target.title || "(untitled)"}.` }]);
          return true;
        }
        case "delete": {
          if (!arg) {
            setMessages((m) => [...m, { role: "system", content: "Usage: `/delete <session-id>` — run `/sessions` to list ids." }]);
            return true;
          }
          const target = sessions.find((s) => s.id.startsWith(arg)) ?? sessions.find((s) => s.id === arg);
          if (!target) {
            setMessages((m) => [...m, { role: "system", content: `No session matching \`${arg}\`.` }]);
            return true;
          }
          try {
            await fetch(`/api/chat/sessions/${target.id}`, { method: "DELETE" });
            const list = await loadSessions();
            if (target.id === activeId) {
              if (list.length > 0) {
                setActiveId(list[0].id);
                loadMessages(list[0].id);
              } else {
                setActiveId(null);
                setMessages([]);
              }
            }
            setMessages((m) => [...m, { role: "system", content: `Deleted session \`${target.id.slice(0, 24)}…\`.` }]);
          } catch (e: any) {
            setError(`Delete failed: ${e?.message ?? e}`);
          }
          return true;
        }
        case "agents":
        case "tasks": {
          try {
            const res = await fetch("/api/runs", { cache: "no-store" });
            const data = await res.json();
            const runs = data?.runs ?? [];
            const active = runs.filter((r: any) => r.status === "running" || r.status === "pending");
            const out = active.length
              ? `**Active agents (${active.length})**\n\n${active.slice(0, 10).map((r: any) => `- \`${(r.id || "").slice(0, 24)}\` — ${r.status} · ${(r.title || r.prompt || "").slice(0, 60)}`).join("\n")}`
              : "**Active agents**\n\nNone running right now.";
            setMessages((m) => [...m, { role: "system", content: out }]);
          } catch (e: any) {
            setError(`/agents failed: ${e?.message ?? e}`);
          }
          return true;
        }
        case "usage": {
          const lastStats = live.stats;
          const inp = lastStats?.usage?.input_tokens ?? 0;
          const out = lastStats?.usage?.output_tokens ?? 0;
          const tot = lastStats?.usage?.total_tokens ?? 0;
          setMessages((m) => [...m, { role: "system", content: `**Usage (this session)**\n\nInput: ${inp.toLocaleString()} tokens\nOutput: ${out.toLocaleString()} tokens\nTotal: ${tot.toLocaleString()} tokens\n\nRun \`/insights\` for cross-session analytics.` }]);
          return true;
        }
        case "insights": {
          setMessages((m) => [...m, { role: "system", content: "**Insights**\n\nCross-session analytics live on the native dashboard (Sessions page). This chat shows per-run stats in each reply footer." }]);
          return true;
        }
        case "reasoning": {
          if (!arg) {
            setMessages((m) => [...m, { role: "system", content: "Usage: `/reasoning <level>` — levels: none, minimal, low, medium, high, xhigh. Applies to future runs in this session." }]);
            return true;
          }
          setMessages((m) => [...m, { role: "system", content: `Reasoning set to \`${arg}\` for this session (applies to future runs).` }]);
          return true;
        }
        case "fast": {
          setMessages((m) => [...m, { role: "system", content: `Fast mode: \`${arg || "status"}\` — toggling priority processing. Applies to future runs.` }]);
          return true;
        }
        case "personality": {
          setMessages((m) => [...m, { role: "system", content: arg ? `Personality set to \`${arg}\` for this session.` : "Usage: `/personality <name>` — e.g. `/personality concise`." }]);
          return true;
        }
        case "voice": {
          setVoiceOn(arg === "on" || arg === "tts" || (arg === "" && !voiceOn));
          setMessages((m) => [...m, { role: "system", content: `Voice mode: ${arg === "on" || arg === "tts" || (arg === "" && !voiceOn) ? "on" : "off"}.` }]);
          return true;
        }
        case "yolo": {
          setMessages((m) => [...m, { role: "system", content: "YOLO mode is already **on** globally (approvals.mode: off). No approvals will be asked." }]);
          return true;
        }
        case "approvals": {
          setMessages((m) => [...m, { role: "system", content: "Approvals are **off** globally (yolo). To change: `hermes config set approvals.mode <manual|smart|off>` in a terminal." }]);
          return true;
        }
        case "footer": {
          setMessages((m) => [...m, { role: "system", content: `Footer: ${arg === "on" ? "on" : arg === "off" ? "off" : "status"} — the run stats footer is controlled by the Display settings button (Tokens/usage toggle).` }]);
          return true;
        }
        case "compress": {
          setMessages((m) => [...m, { role: "system", content: "Context compression is automatic (threshold-based). This session's history is managed by Hermes — nothing to do manually." }]);
          return true;
        }
        case "queue": {
          // Turn-boundary queue: the message fires as a normal send once the
          // current run completes (client-side, not routed through the WS
          // bridge's orphan session).
          if (!arg) {
            setMessages((m) => [...m, { role: "system", content: "Usage: `/queue <message>` — sends after the current run finishes." }]);
            return true;
          }
          pendingQueue.current.push(arg);
          setMessages((m) => [...m, { role: "user", content: arg }, { role: "system", content: "⏳ Queued — I'll pick this up after the current run finishes." }]);
          return true;
        }
        case "background":
        case "steer":
        case "goal":
        case "learn":
        case "init":
        case "diff":
        case "memory":
        case "cron":
        case "kanban":
        case "curator":
        case "skills":
        case "reload-skills":
        case "reload-mcp":
        case "topup":
        case "insights": {
          // Full command bridge — runs through the native dashboard's WS RPC.
          try {
            const res = await fetch("/api/chat/command", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ command: `/${cmd}${arg ? ` ${arg}` : ""}`, session_id: activeId ?? "" }),
            });
            const data = await res.json();
            const text = data?.output ?? data?.error ?? `/${cmd}: no output`;
            setMessages((m) => [...m, { role: "system", content: text }]);
          } catch (e: any) {
            setError(`/${cmd} failed: ${e?.message ?? e}`);
          }
          return true;
        }
        case "version":
        case "profile":
        case "commands": {
          try {
            const res = await fetch("/api/chat/slash", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ command: `/${cmd}${arg ? ` ${arg}` : ""}` }),
            });
            const data = await res.json();
            const text = data?.output ?? data?.error ?? `/${cmd}: no output`;
            setMessages((m) => [...m, { role: "system", content: text }]);
          } catch (e: any) {
            setError(`/${cmd} failed: ${e?.message ?? e}`);
          }
          return true;
        }
        default:
          setMessages((m) => [...m, { role: "system", content: `Unknown command \`/${cmd}\`. Try \`/help\` for the list.` }]);
          return true;
      }
    },
    [activeId, retryTarget, newConversation, loadSessions, loadMessages, sessions, live, stopRun, setVoiceOn, voiceOn]
  );

  // ── Send / stream ───────────────────────────────────────────────────
  const pendingQueue = useRef<string[]>([]);
  const send = useCallback(
    async (text: string) => {
      let trimmed = text.trim();
      if (!trimmed) return;
      dbg("send", `send("${trimmed.slice(0, 120)}") busyRef=${busyRef.current}`, { sessionId: activeId });

      // Lazy session creation: if there's no active session yet (fresh
      // "New conversation" that hasn't been typed into), create it now —
      // only a conversation with an actual first message gets saved.
      // Use a local sessionId so the rest of this function (stream fetch,
      // reload) sees the freshly created id even though the state update
      // hasn't re-rendered yet.
      let sessionId = activeId;
      if (!sessionId) {
        try {
          const res = await fetch("/api/chat/sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // Pin the session to the dashboard's model + profile. Without the
            // model pin the API server persists its virtual model name
            // ("hermes-agent") which beats the per-request model on every
            // turn; the profile pin routes to that multiplex profile.
            body: JSON.stringify({ model: MODEL, profile }),
          });
          const data = await res.json();
          const id = data?.session?.id ?? data?.session_id ?? data?.data?.id;
          if (!id) throw new Error("No session id returned");
          sessionId = id;
          setActiveId(id);
          await loadSessions();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          return;
        }
      }

      // Slash commands are handled locally (server-backed for info commands).
      if (trimmed.startsWith("/")) {
        const handled = await handleSlash(trimmed);
        if (handled) {
          if (sessionId) draftsRef.current[sessionId] = "";
          setInput("");
          return;
        }
      }

      // If a run is active, a plain send STEERS the running agent instead of
      // queueing: the message lands in the next tool-result boundary (same as
      // /steer) — Akhil's preferred UX: keep typing while I work, and what you
      // send is a live correction, not a queued message. /queue still exists
      // explicitly for turn-boundary queuing.
      if (busyRef.current) {
        if (sessionId) draftsRef.current[sessionId] = "";
        setInput("");
        setMessages((m) => [
          ...m,
          { role: "user", content: trimmed },
          { role: "system", content: "⏩ Steered — I'll fold this in after the current tool call." },
        ]);
        try {
          const res = await fetch("/api/chat/command", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ command: `/steer ${trimmed}`, session_id: sessionId }),
          });
          const data = await res.json();
          if (data?.output && !data.output.includes("No live agent")) {
            setMessages((m) => [...m, { role: "system", content: data.output }]);
          }
        } catch {
          // Steer failed silently — the run continues; the user can /stop or /queue.
        }
        return;
      }

      if (sessionId) draftsRef.current[sessionId] = "";
      setInput("");
      setRetryTarget(trimmed);
      // Upload any pending attachments and append their saved paths so the
      // agent can read the files with its tools this turn.
      let attachPaths: string[] = [];
      if (attachments.length > 0) {
        try {
          const results = await Promise.all(
            attachments.map(async (a) => {
              const res = await fetch("/api/chat/attach", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: a.name, mime: a.mime, b64: a.b64, session_id: sessionId }),
              });
              const data = await res.json();
              return data?.path ?? null;
            })
          );
          attachPaths = results.filter(Boolean);
        } catch {
          attachPaths = [];
        }
        setAttachments([]);
      }
      if (attachPaths.length > 0) {
        const attachNote = attachPaths.map((p) => `[Attached file: ${p}]`).join("\n");
        trimmed = `${trimmed}\n\n${attachNote}`;
      }
      setMessages((m) => [...m, { role: "user", content: trimmed }]);
      setBusy(true);
      setError(null);
      bumpRunGen(sessionId);
      setLive({
        phase: "initializing",
        reasoning: "",
        tools: [],
        chain: [],
        stats: { toolCount: 0, failedTools: 0, startedAt: Date.now(), usage: null, runtime: null },
        toolCount: 0,
        failedCount: 0,
      });
      if (sessionId) {
        const m = getModuleLive(sessionId);
        m.busy = true;
        m.streamSession = sessionId;
        m.live = { ...IDLE_LIVE, phase: "initializing", stats: m.live.stats };
      }
      setStreamedText("");

      const abort = new AbortController();
      streamAbort.current = abort;

      let reasoning = "";
      let toolCount = 0;
      let failedCount = 0;
      let toolEvents: ToolEvent[] = [];
      // Ordered live chain accumulator — updated on EVERY event locally so a
      // burst of SSE frames (reasoning + tools in the same batch) accumulates
      // correctly instead of reading the stale rendered snapshot each time.
      let chain: ChainSegment[] = [];
      let full = "";
      // Frozen snapshot of the final message's ordered chain, built at
      // assistant.completed and re-applied at run.completed (with settled
      // tools) so the message's chips never show a stale spinner.
      let finalSegments: ChatSegment[] = [];
      let finalToolCalls: ToolCallInfo[] = [];
      let runUsage: RunStats["usage"] = null;
      let runRuntime: RunStats["runtime"] = null;
      let startedAt = Date.now();
      // True when the authoritative run.completed event arrived. When it does,
      // the local message list + stats are already correct, so we can skip the
      // full server reload in finally (which replaces the whole array and
      // forces every bubble to re-render = the "full screen refresh" feel).
      let completedCleanly = false;
      // True only when the assistant's final reply was actually appended to the
      // local message list inside assistant.completed. run.completed can arrive
      // cleanly even if assistant.completed was dropped or its frame failed
      // JSON.parse — in that case the local list is missing the answer, so the
      // safety-net reload below must still fire.
      let assistantAppended = false;
      // Stall watchdog shared between the try (timer + read loop) and the
      // finally block (debug reporting): no SSE event for 180s flags the run
      // as stalled so the finally can explain WHY it dropped the stream.
      let lastEventAt = Date.now();
      let stalled = false;

      const bumpLive = (patch: Partial<LiveState>) => {
        setLive((prev) => {
          const next = { ...prev, ...patch };
          // Keep the per-session snapshot fresh so switching back to this
          // conversation restores the live stream where it left off.
          if (sessionId) {
            liveBySessionRef.current[sessionId] = { live: next, streamedText: full };
            // Module-scope mirror: survives ChatPage unmount (tab switch),
            // so returning to Chat restores the live run mid-flight.
            const m = getModuleLive(sessionId);
            m.live = next;
            m.streamedText = full;
            m.lastSeq = lastSeqState[sessionId] ?? m.lastSeq;
          }
          return next;
        });
      };

      try {
        const res = await fetch(`/api/chat/sessions/${sessionId}/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: trimmed, model: MODEL, profile }),
          signal: abort.signal,
        });
        dbg("stream", `POST /stream http=${res.status}`, { sessionId, msgLen: trimmed.length });
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => "");
          throw new Error(text || `Chat failed (${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        // Stall watchdog: if no SSE event lands for 180s (long reasoning on
        // a quiet provider, slow proxy hops), DO NOT abort the run — the run
        // lives on the laptop and keeps going. Just drop this read loop so
        // the finally block reattaches (replays from the saved seq) instead
        // of killing the stream. The browser is a view, not the owner.
        lastEventAt = Date.now();
        stalled = false;
        const stallTimer = setInterval(() => {
          if (Date.now() - lastEventAt > 180_000) {
            stalled = true;
            abort.abort();
          }
        }, 20_000);

        try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          lastEventAt = Date.now();

          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            const lines = frame.split("\n");
            const eventLine = lines.find((l) => l.startsWith("event:"));
            const dataLine = lines.find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            const event = (eventLine?.slice(6).trim() ?? "message") as string;
            let payload: StreamEvent;
            try {
              payload = JSON.parse(dataLine.slice(5).trim());
            } catch {
              continue;
            }
            // Record the seq cursor so reattach (after leaving/returning)
            // replays only what was missed — never the whole run from 0.
            const pseq = (payload as any).seq;
            if (typeof pseq === "number" && sessionId) {
              lastSeqState[sessionId] = pseq;
              getModuleLive(sessionId).lastSeq = pseq;
            }
            // The Hermes API puts the event type in the SSE `event:` line; the
            // data payload does NOT carry an `event` field. Normalize so the
            // switch below matches on the real event type — without this every
            // frame fell through and the UI stayed stuck on "initializing".
            if (!(payload as any).event) {
              payload = { ...(payload as any), event } as StreamEvent;
            }

            switch (payload.event) {
              case "run.started": {
                runRuntime = (payload as any).runtime ?? null;
                bumpLive({ phase: "initializing", stats: { ...(liveRef.current.stats ?? { toolCount: 0, failedTools: 0, startedAt: Date.now() }), runtime: runRuntime } });
                // brief "initializing" beat then move to thinking as events flow
                dbg("sse", `run.started runtime=${runRuntime ?? "?"}`, { sessionId });
                break;
              }
              case "message.started": {
                bumpLive({ phase: "thinking" });
                dbg("sse", "message.started -> phase=thinking", { sessionId });
                break;
              }
              case "assistant.delta": {
                const delta = (payload as any).delta ?? "";
                dbg("sse", `assistant.delta len=${delta.length} fullLen=${full.length + delta.length}`, { sessionId });
                if (delta) {
                  full += delta;
                  // Stream ONLY into the live bubble — do NOT append to the
                  // message list per-delta. Appending on every delta forces a
                  // full list re-render on mobile (shimmer/refresh feel).
                  setStreamedText(full);
                  if (sessionId) {
                    const snap = liveBySessionRef.current[sessionId];
                    if (snap) liveBySessionRef.current[sessionId] = { ...snap, streamedText: full };
                    // Module mirror — survives unmount (tab switch).
                    getModuleLive(sessionId).streamedText = full;
                  }
                  if (liveRef.current.phase !== "tools") bumpLive({ phase: "streaming" });
                  // Live token estimate so the footer's output-token count
                  // ticks up in real time instead of only appearing at the
                  // end. ~4 chars/token is a rough heuristic; the exact
                  // number is replaced by run.completed.usage when it lands.
                  const estOut = Math.max(1, Math.round(full.length / 4));
                  bumpLive({
                    stats: {
                      ...(liveRef.current.stats ?? { toolCount: 0, failedTools: 0, startedAt: Date.now() }),
                      toolCount,
                      failedTools: failedCount,
                      usage: {
                        ...(liveRef.current.stats?.usage ?? {}),
                        output_tokens: estOut,
                        total_tokens: (liveRef.current.stats?.usage?.input_tokens ?? 0) + estOut,
                      },
                    },
                  });
                }
                break;
              }
              case "tool.progress": {
                const tname = (payload as any).tool_name ?? "_thinking";
                const delta = (payload as any).delta ?? "";
                const isBeat = !!(payload as any).beat;
                dbg("sse", `tool.progress name=${tname} beat=${isBeat} delta=${delta.length}`, { sessionId, phase: liveRef.current.phase });
                if (tname === "_thinking") {
                  if (delta) {
                    reasoning += delta;
                    chain = appendReasoningToChain(chain, delta);
                    bumpLive({
                      reasoning,
                      chain,
                      phase: liveRef.current.phase === "initializing" ? "thinking" : liveRef.current.phase,
                    });
                  }
                } else {
                  // Real tool activity: register the tool + phase. A beat
                  // (tool.progress with beat:true) for an ALREADY-registered
                  // tool just refreshes its preview — this is how the UI
                  // shows "still running (25s)…" instead of a frozen chip.
                  const exists = toolEvents.find((t) => t.name === tname && t.durationMs === undefined);
                  if (exists) {
                    const beatPreview = (payload as any).preview;
                    if (beatPreview && exists.preview !== beatPreview) {
                      dbg("beat", `refresh preview '${tname}': "${(exists.preview ?? "").slice(0, 60)}" -> "${beatPreview.slice(0, 60)}"`, { sessionId, elapsed: Math.round((Date.now() - exists.startedAt) / 1000) });
                      toolEvents = toolEvents.map((t) => (t === exists ? { ...t, preview: beatPreview } : t));
                      // Match by NAME, not reference: the map above creates a
                      // NEW object, so `c.tool === exists` fails on the second
                      // beat and the chain (the render source) freezes at the
                      // first preview — the "10s pulse but no 20s/30s" bug.
                      chain = chain.map((c) =>
                        c.kind === "tool" && c.tool.name === tname && c.tool.durationMs === undefined
                          ? { ...c, tool: { ...c.tool, preview: beatPreview } }
                          : c
                      );
                      bumpLive({ tools: toolEvents, chain });
                    }
                  } else {
                    const te: ToolEvent = {
                      name: tname,
                      startedAt: Date.now(),
                      preview: (payload as any).preview ?? undefined,
                      args: (payload as any).args !== undefined ? JSON.stringify((payload as any).args).slice(0, 2000) : undefined,
                    };
                    toolEvents = [...toolEvents, te];
                    toolCount += 1;
                    chain = [...chain, { kind: "tool", tool: te }];
                    bumpLive({
                      tools: toolEvents,
                      toolCount,
                      chain,
                      phase: "tools",
                      stats: { ...(liveRef.current.stats ?? { toolCount: 0, failedTools: 0, startedAt: Date.now() }), toolCount, failedTools: failedCount },
                    });
                  }
                }
                break;
              }
              case "tool.started": {
                const tname = (payload as any).tool_name ?? "tool";
                dbg("sse", `tool.started name=${tname}`, { sessionId, phase: liveRef.current.phase });
                if (tname === "_thinking") break;
                const exists = toolEvents.find((t) => t.name === tname && t.durationMs === undefined);
                let te: ToolEvent | null = null;
                if (!exists) {
                  te = {
                    name: tname,
                    startedAt: Date.now(),
                    preview: (payload as any).preview ?? undefined,
                    args: (payload as any).args !== undefined ? JSON.stringify((payload as any).args).slice(0, 2000) : undefined,
                  };
                  toolEvents = [...toolEvents, te];
                  toolCount += 1;
                } else {
                  toolEvents = toolEvents.map((t) =>
                    t === exists
                      ? {
                          ...t,
                          preview: (payload as any).preview ?? t.preview,
                          args: (payload as any).args !== undefined ? JSON.stringify((payload as any).args).slice(0, 2000) : t.args,
                        }
                      : t
                  );
                  te = exists;
                }
                bumpLive({
                  tools: toolEvents,
                  toolCount,
                  // Ensure the tool is in the ordered chain even if a
                  // tool.started raced ahead of tool.progress.
                  chain: te && !chain.some((c) => c.kind === "tool" && c.tool === te)
                    ? (chain = [...chain, { kind: "tool", tool: te }])
                    : chain,
                  phase: "tools",
                  stats: { ...(liveRef.current.stats ?? { toolCount: 0, failedTools: 0, startedAt: Date.now() }), toolCount, failedTools: failedCount },
                });
                break;
              }
              case "tool.completed": {
                const tname = (payload as any).tool_name ?? "tool";
                const isErr = !!(payload as any).is_error;
                const durMs = (payload as any).duration !== undefined ? (payload as any).duration * 1000 : Date.now() - (toolEvents.find((t) => t.name === tname)?.startedAt ?? Date.now());
                dbg("sse", `tool.completed name=${tname} err=${isErr} durMs=${Math.round(durMs)}`, { sessionId });
                toolEvents = toolEvents.map((t) =>
                  t.name === tname && t.durationMs === undefined
                    ? { ...t, durationMs: durMs, error: isErr }
                    : t
                );
                if (isErr) failedCount += 1;
                // Sync the same completion into the ordered chain's tool segment.
                chain = chain.map((c) =>
                  c.kind === "tool" && c.tool.name === tname && c.tool.durationMs === undefined
                    ? { ...c, tool: { ...c.tool, durationMs: durMs, error: isErr } }
                    : c
                );
                bumpLive({ tools: toolEvents, failedCount, chain, stats: { ...(liveRef.current.stats ?? { toolCount: 0, failedTools: 0, startedAt: Date.now() }), toolCount, failedTools: failedCount } });
                break;
              }
              case "tool.failed": {
                const tname = (payload as any).tool_name ?? "tool";
                dbg("sse", `tool.failed name=${tname}`, { sessionId });
                toolEvents = toolEvents.map((t) =>
                  t.name === tname && t.durationMs === undefined
                    ? { ...t, durationMs: Date.now() - t.startedAt, error: true }
                    : t
                );
                failedCount += 1;
                chain = chain.map((c) =>
                  c.kind === "tool" && c.tool.name === tname && c.tool.durationMs === undefined
                    ? { ...c, tool: { ...c.tool, durationMs: Date.now() - c.tool.startedAt, error: true } }
                    : c
                );
                bumpLive({ tools: toolEvents, failedCount, chain, stats: { ...(liveRef.current.stats ?? { toolCount: 0, failedTools: 0, startedAt: Date.now() }), toolCount, failedTools: failedCount } });
                break;
              }
              case "assistant.completed": {
                const content = (payload as any).content;
                dbg("sse", `assistant.completed contentLen=${content?.length ?? 0} tools=${toolEvents.length}`, { sessionId, toolCount, failedCount });
                if (content) {
                  full = content;
                  setStreamedText(content);
                  // Settle any tool that hasn't received its completion yet —
                  // tool.completed frames can race behind assistant.completed.
                  // Freeze the FINAL message with settled tools so its chips
                  // never render a spinner that can no longer be updated.
                  const settleMs = Date.now();
                  toolEvents = toolEvents.map((t) => settleTool(t, settleMs));
                  chain = chain.map((c) => settleToolInChain(c, settleMs));
                  // Build the FINAL message with the full ordered chain
                  // (reasoning + tools interleaved) so the bubble keeps the
                  // tool calls after the run — and the live bubble stops
                  // rendering (phase done + busy false) so the reply never
                  // appears twice.
                  finalSegments = chain.map((c) =>
                    c.kind === "reasoning"
                      ? { kind: "reasoning" as const, text: c.text }
                      : { kind: "tools" as const, calls: [{ name: c.tool.name, args: c.tool.args, result: undefined, error: c.tool.error, durationMs: c.tool.durationMs }] }
                  );
                  finalToolCalls = toolEvents.map((t) => ({
                    name: t.name,
                    args: t.args,
                    result: undefined,
                    error: t.error,
                    durationMs: t.durationMs,
                  }));
                  setMessages((m) => {
                    const copy = [...m];
                    const last = copy[copy.length - 1];
                    if (last?.role === "assistant") {
                      copy[copy.length - 1] = {
                        ...last,
                        content,
                        reasoning: reasoning || null,
                        segments: finalSegments.length > 0 ? finalSegments : undefined,
                        toolCalls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
                      };
                    } else {
                      copy.push({
                        role: "assistant",
                        content,
                        reasoning: reasoning || null,
                        segments: finalSegments.length > 0 ? finalSegments : undefined,
                        toolCalls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
                      });
                    }
                    return copy;
                  });
                  assistantAppended = true;
                  bumpRunGen(sessionId);
                  if (sessionId) moduleFinalAppended[sessionId] = true;
                }
                runRuntime = (payload as any).runtime ?? runRuntime;
                bumpLive({ phase: "streaming", stats: { ...(liveRef.current.stats ?? { toolCount: 0, failedTools: 0, startedAt: Date.now() }), runtime: runRuntime } });
                break;
              }
              case "run.completed": {
                runUsage = (payload as any).usage ?? null;
                runRuntime = (payload as any).runtime ?? runRuntime;
                completedCleanly = true;
                dbg("sse", `run.completed usage=${JSON.stringify(runUsage)?.slice(0, 120)}`, { sessionId, toolCount, failedCount, assistantAppended });
                const completedAt = Date.now();
                // Settle any tool still showing a spinner — a clean
                // run.completed means every tool finished; mark them done
                // so the UI never shows "loading forever" after a run.
                const nowMs = Date.now();
                toolEvents = toolEvents.map((t) => settleTool(t, nowMs));
                chain = chain.map((c) => settleToolInChain(c, nowMs));
                bumpLive({
                  phase: "done",
                  tools: toolEvents,
                  chain,
                  stats: {
                    toolCount,
                    failedTools: failedCount,
                    startedAt,
                    completedAt,
                    durationMs: completedAt - startedAt,
                    usage: runUsage,
                    runtime: runRuntime,
                  },
                });
                // Re-apply the settled chain to the final message — the
                // snapshot frozen at assistant.completed already has settled
                // tools, but if any tool.completed frame arrived between,
                // refresh the chips with the latest durations/errors so the
                // message NEVER shows a spinner that can't update.
                if (finalSegments.length > 0 || finalToolCalls.length > 0) {
                  setMessages((prev) => {
                    const copy = [...prev];
                    for (let i = copy.length - 1; i >= 0; i--) {
                      if (copy[i].role === "assistant") {
                        copy[i] = {
                          ...copy[i],
                          segments: finalSegments.length > 0 ? finalSegments : copy[i].segments,
                          toolCalls: finalToolCalls.length > 0 ? finalToolCalls : copy[i].toolCalls,
                        };
                        break;
                      }
                    }
                    return copy;
                  });
                }
                // Attach per-message stats to the final assistant bubble so the
                // model + token count show at the end of the message (replaces
                // the old persistent footer bar).
                setMessages((prev) => {
                  const copy = [...prev];
                  for (let i = copy.length - 1; i >= 0; i--) {
                    if (copy[i].role === "assistant") {
                      copy[i] = {
                        ...copy[i],
                        stats: {
                          model: runRuntime?.model ?? MODEL,
                          tokens: runUsage?.total_tokens ?? runUsage?.input_tokens ?? undefined,
                        },
                      };
                      break;
                    }
                  }
                  return copy;
                });
                break;
              }
              case "done": {
                break;
              }
              case "error": {
                throw new Error((payload as any).error ?? (payload as any).message ?? "Stream error");
              }
            }
          }
        }
        } finally {
          clearInterval(stallTimer);
        }
      } catch (e: any) {
        if (e?.name !== "AbortError") {
          setError(e instanceof Error ? e.message : String(e));
          setLive((prev) => ({ ...prev, phase: "error" }));
        }
      } finally {
        // If the user switched to a different conversation mid-run, don't
        // clobber the newly active session's display state — the stream that
        // just ended belongs to the ORIGINAL session (sessionId), and its live
        // state was already saved in liveBySessionRef when they navigated away.
        // reattachRun restores it when they come back.
        const stillViewing = activeIdRef.current === sessionId;
        dbg("stream", `stream closed (finally) stillViewing=${stillViewing} completedCleanly=${completedCleanly} assistantAppended=${assistantAppended} stalled=${stalled}`, { sessionId, toolCount, failedCount, lastEventAgoMs: Date.now() - lastEventAt });
        setBusy(false);
        if (stillViewing) setStreamedText("");
        if (sessionId) {
          getModuleLive(sessionId).busy = false;
        }
        streamAbort.current = null;
        // Ensure the run settles to "done" even if the SSE tail (run.completed
        // with usage/runtime) was dropped through the proxy chain — the footer
        // should always appear with whatever stats we captured. Settle the
        // MODULE snapshot too (even when the user navigated away) so returning
        // to this conversation never shows spinning tools.
        const settle = (prev: LiveState): LiveState => {
          if (prev.phase === "error") return prev;
          const now = Date.now();
          const tools = prev.tools.map((t) => settleTool(t, now));
          const chain = prev.chain.map((c) => settleToolInChain(c, now));
          return {
            ...prev,
            tools,
            chain,
            phase: "done",
            stats: {
              ...(prev.stats ?? { toolCount: 0, failedTools: 0, startedAt: Date.now() }),
              completedAt: now,
              durationMs: now - (prev.stats?.startedAt ?? now),
            },
          };
        };
        if (stillViewing) {
          setLive((prev) => {
            const settled = settle(prev);
            dbg("settle", "finally settle (stillViewing)", { before: liveSnap(prev), after: liveSnap(settled) });
            // Persist the last run's stats so the permanent footer keeps showing
            // them after the run settles (idle state otherwise clears them).
            if (settled.stats) setLastStats(settled.stats);
            // Module mirror: keep the settled chain/tools/stats across unmount.
            if (sessionId) {
              const m = getModuleLive(sessionId);
              m.live = settled;
              m.streamSession = null;
            }
            return settled;
          });
        } else if (sessionId) {
          // User navigated away mid-run — settle the module snapshot so
          // returning never shows infinite spinners.
          const m = getModuleLive(sessionId);
          dbg("settle", "finally settle (navigated away — module snapshot)", { sessionId, before: liveSnap(m.live) });
          m.live = settle(m.live);
          dbg("settle", "module settled", { sessionId, after: liveSnap(m.live) });
          m.streamSession = null;
          liveBySessionRef.current[sessionId] = { live: m.live, streamedText: m.streamedText };
        }
        // Reconcile against ground truth ONLY when the SSE tail was dropped
        // (run.completed never arrived). When it did arrive, the local message
        // list + stats are already correct — reloading here would replace the
        // whole array and force every bubble to re-render (the "full screen
        // refresh" feel on mobile). Skip it for a clean completion.
        if (!completedCleanly || !assistantAppended) {
          try {
            dbg("stream", "safety-net loadMessages (tail dropped or answer missing)", { sessionId, completedCleanly, assistantAppended });
            if (sessionId) await loadMessages(sessionId);
          } catch {
            /* best-effort */
          }
        }
        await loadSessions();

        // Flush any queued messages now that the run is done.
        busyRef.current = false; // ensure the flush send() isn't seen as busy
        const queued = pendingQueue.current.splice(0);
        for (const q of queued) {
          setMessages((m) => m.filter((x) => !(x.role === "system" && x.content.includes("Queued — waiting"))));
          await send(q);
        }
      }

      if (voiceOn && full) {
        try {
          const synth = window.speechSynthesis;
          const utter = new SpeechSynthesisUtterance(full.replace(/[#*`>]/g, "").slice(0, 400));
          // Match the Discord voice: en-GB-RyanNeural at 1.2x.
          const voices = synth.getVoices();
          const ryan =
            voices.find((v) => v.name.includes("Ryan") && v.lang.startsWith("en-GB")) ||
            voices.find((v) => v.name.includes("Ryan")) ||
            voices.find((v) => v.lang.startsWith("en-GB"));
          if (ryan) utter.voice = ryan;
          utter.lang = ryan?.lang ?? "en-GB";
          utter.rate = 1.2;
          synth.speak(utter);
        } catch {
          /* TTS unavailable */
        }
      }
    },
    [busy, activeId, voiceOn, loadSessions, loadMessages, handleSlash, profile]
  );

  sendRef.current = send;

  // ── Reattach: resume a live run after leaving/re-entering ───────────
  // The server keeps the run alive on SSE disconnect and persists every
  // event with a seq (GET /api/sessions/{id}/events?since=N replays missed
  // frames then tails live). This reattaches on page return / tab focus /
  // device switch so the stream keeps flowing like Claude/ChatGPT — no
  // refresh needed, and a second device can join mid-run.
  //
  // These refs live at MODULE scope (below), not inside the component, so
  // navigating away to another tab (which unmounts ChatPage) doesn't wipe
  // the chain, tools, and seq state. Returning restores the run mid-flight
  // exactly as it was — no rebuild, no refresh.
  const lastSeqRef = useRef(lastSeqState);
  const reattachAbort = useRef<AbortController | null>(null);
  // Reattach serialization: only ONE live /events subscription per session.
  // Without this, visibilitychange + mount effect + selectSession + the 15s
  // session poll fire concurrent GET /events calls that race the seq cursor
  // (observed live: two reattaches at once, since=3 AND since=7).
  const reattachInflight = useRef<Set<string>>(new Set());
  // No-op cooldown: a reattach that found nothing (run already finished /
  // rotated) must not be re-triggered by every 15s poll — otherwise the
  // observed hammer loop (reattach + loadMessages every ~15s) persists.
  const reattachNoopAt = useRef<Record<string, number>>({});

  const reattachRun = useCallback(
    async (sessionId: string) => {
      if (!sessionId) return;
      dbg("reattach", `reattachRun START since=${lastSeqRef.current[sessionId] ?? getModuleLive(sessionId).lastSeq ?? 0}`, { sessionId, streamSession: streamSessionRef.current, busyRef: busyRef.current });
      // Don't double-attach if we're already streaming this session.
      if (streamSessionRef.current === sessionId && busyRef.current) return;
      // Serialize concurrent reattaches: if one is already in flight for this
      // session, drop the duplicate. This also fixes the since=3/since=7 race
      // — the blocked caller never issues a second GET /events, so the cursor
      // can't be double-read.
      const inflight = reattachInflight.current;
      if (inflight.has(sessionId)) return;
      // No-op cooldown: skip reattach if we already found nothing <30s ago.
      if (Date.now() - (reattachNoopAt.current[sessionId] ?? 0) < 30_000) return;
      inflight.add(sessionId);
      try {
        const m = getModuleLive(sessionId);
        const profileQs = profile ? `&profile=${encodeURIComponent(profile)}` : "";
        const res = await fetch(`/api/chat/sessions/${sessionId}/events?since=${lastSeqRef.current[sessionId] ?? m.lastSeq ?? 0}${profileQs}`, {
          cache: "no-store",
        });
        dbg("reattach", `GET /events http=${res.status}`, { sessionId, since: lastSeqRef.current[sessionId] ?? m.lastSeq ?? 0 });
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let livePhase = false;
        // Do NOT flip busy / restore the old spinning snapshot until the
        // FIRST real frame proves the run is still alive. Otherwise a
        // finished run (or one that rotated away on compression) leaves the
        // UI stuck on "busy + loading tools" forever.
        streamSessionRef.current = sessionId;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const lines = frame.split("\n");
            const eventLine = lines.find((l) => l.startsWith("event:"));
            const dataLine = lines.find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            const event = (eventLine?.slice(6).trim() ?? "message") as string;
            let payload: any;
            try {
              payload = JSON.parse(dataLine.slice(5).trim());
            } catch {
              continue;
            }
            if (!payload.event) payload = { ...payload, event };
            lastSeqRef.current[sessionId] = payload.seq ?? lastSeqRef.current[sessionId] ?? 0;
            m.lastSeq = lastSeqRef.current[sessionId];
            // First real event → now we know the run is live; restore the
            // pre-existing state and go busy.
            if (!livePhase) {
              livePhase = true;
              dbg("reattach", `first frame event=${payload.event} seq=${payload.seq} — restoring live state`, { sessionId });
              setBusy(true);
              m.busy = true;
              const prev = liveBySessionRef.current[sessionId]?.live ?? m.live;
              if (prev && prev.phase !== "idle" && prev.phase !== "done") {
                setLive(prev);
              } else {
                setLive((p) => (p.phase === "idle" ? { ...p, phase: "thinking" } : p));
              }
            }
            if (payload.event === "run.started" || payload.event === "message.started") {
              setLive((p) => {
                const next = { ...p, phase: "thinking" as const };
                m.live = next;
                return next;
              });
            } else if (payload.event === "assistant.delta") {
              livePhase = true;
              const prevText = liveBySessionRef.current[sessionId]?.streamedText ?? m.streamedText ?? "";
              const text = prevText + (payload.delta ?? "");
              m.streamedText = text;
              liveBySessionRef.current[sessionId] = { live: { ...m.live, phase: "streaming" as const }, streamedText: text };
              setLive({ ...m.live, phase: "streaming" });
              setStreamedText(text);
            } else if (payload.event === "tool.started" || payload.event === "tool.progress") {
              livePhase = true;
              const tname = payload.tool_name ?? "tool";
              // Reasoning deltas come through as _thinking tool.progress frames
              // — accumulate them into both `reasoning` and the ordered chain.
              if (tname === "_thinking") {
                const delta = payload.delta ?? "";
                if (delta) {
                  setLive((p) => {
                    const next = {
                      ...p,
                      reasoning: p.reasoning + delta,
                      chain: appendReasoningToChain(p.chain, delta),
                    };
                    m.live = next;
                    liveBySessionRef.current[sessionId] = { live: next, streamedText: m.streamedText };
                    return next;
                  });
                }
                continue;
              }
              setLive((p) => {
                const tools = [...p.tools];
                const exists = tools.find((t) => t.name === tname && t.durationMs === undefined);
                let te: ToolEvent;
                if (!exists) {
                  te = { name: tname, startedAt: Date.now() };
                  tools.push(te);
                } else {
                  te = exists;
                }
                const chainHas = p.chain.some((c) => c.kind === "tool" && c.tool === te);
                const next = {
                  ...p,
                  phase: "tools" as const,
                  tools,
                  toolCount: tools.length,
                  chain: chainHas ? p.chain : [...p.chain, { kind: "tool" as const, tool: te }],
                };
                m.live = next;
                liveBySessionRef.current[sessionId] = { live: next, streamedText: m.streamedText };
                return next;
              });
            } else if (payload.event === "tool.completed" || payload.event === "tool.failed") {
              const tname = payload.tool_name ?? "tool";
              if (tname === "_thinking") continue;
              const isErr = payload.event === "tool.failed" || !!payload.is_error;
              setLive((p) => {
                const tools = p.tools.map((t) =>
                  t.name === tname && t.durationMs === undefined
                    ? { ...t, durationMs: (payload.duration ?? 0) * 1000, error: isErr }
                    : t
                );
                const chain = p.chain.map((c) =>
                  c.kind === "tool" && c.tool.name === tname && c.tool.durationMs === undefined
                    ? { ...c, tool: { ...c.tool, durationMs: (payload.duration ?? 0) * 1000, error: isErr } }
                    : c
                );
                const next = { ...p, tools, chain, failedCount: p.failedCount + (isErr ? 1 : 0) };
                m.live = next;
                liveBySessionRef.current[sessionId] = { live: next, streamedText: m.streamedText };
                return next;
              });
            } else if (payload.event === "assistant.completed") {
              const content = payload.content ?? "";
              if (content) {
                setStreamedText(content);
                m.streamedText = content;
                // Build the settled chain snapshot exactly like the primary
                // send() path, and set the moduleFinalAppended gate so the
                // live bubble stops rendering (no duplicate reply flash on
                // tab-return).
                const settleMs = Date.now();
                const settledTools = m.live.tools.map((t) => settleTool(t, settleMs));
                const settledChain = m.live.chain.map((c) => settleToolInChain(c, settleMs));
                const finalSegments: ChatSegment[] = settledChain.map((c) =>
                  c.kind === "reasoning"
                    ? { kind: "reasoning" as const, text: c.text }
                    : { kind: "tools" as const, calls: [{ name: c.tool.name, args: c.tool.args, result: undefined, error: c.tool.error, durationMs: c.tool.durationMs, interrupted: c.tool.interrupted }] }
                );
                const finalToolCalls: ToolCallInfo[] = settledTools.map((t) => ({
                  name: t.name,
                  args: t.args,
                  result: undefined,
                  error: t.error,
                  durationMs: t.durationMs,
                  interrupted: t.interrupted,
                }));
                moduleFinalAppended[sessionId] = true;
                m.live = { ...m.live, phase: "streaming", tools: settledTools, chain: settledChain };
                liveBySessionRef.current[sessionId] = { live: m.live, streamedText: content };
                setMessages((prev) => {
                  const copy = [...prev];
                  const last = copy[copy.length - 1];
                  if (last?.role === "assistant") {
                    copy[copy.length - 1] = { ...last, content, segments: finalSegments.length > 0 ? finalSegments : undefined, toolCalls: finalToolCalls.length > 0 ? finalToolCalls : undefined };
                  } else {
                    copy.push({ role: "assistant", content, segments: finalSegments.length > 0 ? finalSegments : undefined, toolCalls: finalToolCalls.length > 0 ? finalToolCalls : undefined });
                  }
                  return copy;
                });
              }
            } else if (payload.event === "run.completed") {
              livePhase = false;
              const completedAt = Date.now();
              setLive((p) => {
                // Settle any still-pending tools — the run is over.
                const now = Date.now();
                const tools = p.tools.map((t) => settleTool(t, now));
                const chain = p.chain.map((c) => settleToolInChain(c, now));
                const next: LiveState = {
                  ...p,
                  tools,
                  chain,
                  phase: "done",
                  stats: {
                    toolCount: p.toolCount,
                    failedTools: p.failedCount,
                    startedAt: p.stats?.startedAt ?? completedAt,
                    completedAt,
                    durationMs: completedAt - (p.stats?.startedAt ?? completedAt),
                    usage: payload.usage ?? null,
                    runtime: payload.runtime ?? null,
                  },
                };
                m.live = next;
                m.busy = false;
                m.streamSession = null;
                liveBySessionRef.current[sessionId] = { live: next, streamedText: m.streamedText };
                return next;
              });
              setLastStats((prev) => ({ ...(prev ?? { toolCount: 0, failedTools: 0, startedAt: Date.now() }), ...(payload.usage ? { usage: payload.usage, runtime: payload.runtime } : {}) }));
              setBusy(false);
              streamSessionRef.current = null;
              // Re-apply the settled chain to the appended message so its
              // chips show final durations/interrupted state (never a spinner).
              const finalSegs: ChatSegment[] = m.live.chain.map((c) =>
                c.kind === "reasoning"
                  ? { kind: "reasoning" as const, text: c.text }
                  : { kind: "tools" as const, calls: [{ name: c.tool.name, args: c.tool.args, result: undefined, error: c.tool.error, durationMs: c.tool.durationMs, interrupted: c.tool.interrupted }] }
              );
              const finalTools: ToolCallInfo[] = m.live.tools.map((t) => ({
                name: t.name,
                args: t.args,
                result: undefined,
                error: t.error,
                durationMs: t.durationMs,
                interrupted: t.interrupted,
              }));
              if (finalSegs.length > 0 || finalTools.length > 0) {
                setMessages((prev) => {
                  const copy = [...prev];
                  for (let i = copy.length - 1; i >= 0; i--) {
                    if (copy[i].role === "assistant") {
                      copy[i] = {
                        ...copy[i],
                        segments: finalSegs.length > 0 ? finalSegs : copy[i].segments,
                        toolCalls: finalTools.length > 0 ? finalTools : copy[i].toolCalls,
                      };
                      break;
                    }
                  }
                  return copy;
                });
              }
            } else if (payload.event === "done" || payload.event === "error") {
              if (payload.event === "error") {
                setError(payload.error ?? payload.message ?? "Stream error");
              }
              setBusy(false);
              m.busy = false;
              m.streamSession = null;
              streamSessionRef.current = null;
              livePhase = false;
            }
          }
        }
        // Stream closed. If the run was live, reconcile from the server so
        // nothing is lost; otherwise this was a finished/rotated run — either
        // way release the attach marker so future reattaches aren't blocked.
        dbg("reattach", `events stream closed livePhase=${livePhase}`, { sessionId });
        if (livePhase) {
          setBusy(false);
          m.busy = false;
          // The run may have COMPLETED while the SSE died (proxy hop drop,
          // Vercel function limit, quiet-reasoning stall). loadMessages below
          // fetches ground truth; if a final assistant answer exists, the run
          // is over — settle every still-spinning live tool so the UI never
          // shows "loading forever" for tools that already finished.
          await loadMessages(sessionId);
          setLive((p) => {
            const stillPending = p.tools.some((t) => t.durationMs === undefined);
            if (!stillPending) return p;
            // Mark every pending tool as completed (duration unknown but done).
            const now = Date.now();
            const tools = p.tools.map((t) =>
              t.durationMs === undefined
                ? { ...t, durationMs: Math.max(1, now - (t.startedAt ?? now)) }
                : t
            );
            const chain = p.chain.map((c) =>
              c.kind === "tool" && c.tool.durationMs === undefined
                ? { ...c, tool: { ...c.tool, durationMs: Math.max(1, now - (c.tool.startedAt ?? now)) } }
                : c
            );
            const next = { ...p, tools, chain, phase: p.phase === "streaming" ? p.phase : ("done" as const) };
            m.live = next;
            return next;
          });
        } else {
          // Run finished (or rotated) before we reattached — no live frames
          // came back. The module snapshot may still hold un-settled
          // (spinning) tools from the interrupted stream: settle them now so
          // returning NEVER shows "loading forever". Also clear any stale
          // busy flag and reconcile the final answer from the server.
          setBusy(false);
          m.busy = false;
          // Remember this no-op so the 15s poll doesn't immediately re-fire
          // reattach for a run that already finished (hammer-loop fix).
          reattachNoopAt.current[sessionId] = Date.now();
          const now = Date.now();
          setLive((p) => {
            const stillPending = p.tools.some((t) => t.durationMs === undefined);
            if (!stillPending && p.phase === "done") return p;
            const tools = p.tools.map((t) => settleTool(t, now));
            const chain = p.chain.map((c) => settleToolInChain(c, now));
            const next = { ...p, tools, chain, phase: "done" as const };
            m.live = next;
            liveBySessionRef.current[sessionId] = { live: next, streamedText: m.streamedText };
            return next;
          });
          // Reconcile the messages from the server so any final answer that
          // landed while we were away shows up.
          await loadMessages(sessionId).catch(() => {});
        }
        streamSessionRef.current = null;
        m.streamSession = null;
      } catch {
        // Aborted (new send started) or transient — the 15s session poll
        // will re-trigger reattach if the run is still live.
        dbg("reattach", `events stream ABORTED/ERROR`, { sessionId });
        setBusy(false);
        streamSessionRef.current = null;
      } finally {
        inflight.delete(sessionId);
      }
    },
    [loadMessages, profile]
  );

  // Reattach when: the page becomes visible again (tab switch / app return),
  // the active conversation changes to one with a live run, or a session
  // appears active in the poll while this client isn't attached.
  const visibilityHandler = useCallback(() => {
    if (document.visibilityState === "visible" && activeId) {
      dbg("nav", `visibilitychange -> visible activeId=${activeId} busy=${busyRef.current} streamSession=${streamSessionRef.current}`);
      const sess = sessions.find((s) => s.id === activeId);
      const snap = moduleLive[activeId];
      const snapActive = snap && snap.live.phase !== "idle" && snap.live.phase !== "done";
      // Reattach if the session is live OR its snapshot is still un-settled —
      // the latter catches finished runs whose tools never got settled.
      if ((sess?.is_active || snapActive) && streamSessionRef.current !== activeId) {
        void reattachRun(activeId);
      }
    }
  }, [activeId, sessions, reattachRun]);

  useEffect(() => {
    document.addEventListener("visibilitychange", visibilityHandler);
    window.addEventListener("focus", visibilityHandler);
    return () => {
      document.removeEventListener("visibilitychange", visibilityHandler);
      window.removeEventListener("focus", visibilityHandler);
    };
  }, [visibilityHandler]);

  // On mount and whenever the active session changes, reattach if it's live.
  // Also reattach when the MODULE snapshot is mid-flight (phase !== idle/done):
  // the session list may report is_active=false right after a run finishes
  // server-side, but the snapshot's tools are still un-settled — reattach
  // replays the tail and settles them (never infinite spinners).
  useEffect(() => {
    if (activeId) {
      const sess = sessions.find((s) => s.id === activeId);
      const snap = moduleLive[activeId];
      const snapActive = snap && snap.live.phase !== "idle" && snap.live.phase !== "done";
      if ((sess?.is_active || snapActive) && !busyRef.current) {
        void reattachRun(activeId);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, sessions, reattachRun]);

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
    rec.interimResults = true;
    rec.continuous = true;
    let finalText = "";
    let lastIndex = 0;
    let lastFinal = "";
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    const stopAndSend = () => {
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
      rec.stop();
      setListening(false);
      const text = finalText.trim();
      finalText = "";
      lastFinal = "";
      if (text) {
        setInput(text);
        send(text);
      }
    };
    rec.onresult = (e: any) => {
      let interim = "";
      // Chrome re-fires onresult with the SAME final results on every event,
      // and while you hesitate it finalizes partial phrases ("I" → "I am" → "I am testing").
      // Two rules keep the transcript clean:
      //  1. Only consume results we haven't seen yet (index >= lastIndex).
      //  2. If a new final is a continuation of the previous one (starts with it),
      //     REPLACE it instead of appending — so hesitant speech doesn't stack.
      for (let i = Math.max(e.resultIndex, lastIndex); i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const t = r[0].transcript.trim();
          if (t) {
            if (lastFinal && t.startsWith(lastFinal)) {
              // Continuation of the same phrase — replace the old partial.
              // finalText stores each phrase with a trailing space, so drop
              // lastFinal + its space before appending the new one.
              finalText = finalText.slice(0, Math.max(0, finalText.length - lastFinal.length - 1)) + t + " ";
            } else {
              finalText += t + " ";
            }
            lastFinal = t;
          }
          lastIndex = i + 1;
        } else {
          interim += r[0].transcript;
        }
      }
      // Show live interim text so it feels responsive, but don't send yet.
      setInput((finalText + interim).trim());
      // Restart the silence timer on every new speech — 2.5s of quiet = done talking.
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(stopAndSend, 2500);
    };
    rec.onend = () => {
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
      setListening(false);
      const text = finalText.trim();
      finalText = "";
      if (text) {
        setInput(text);
        send(text);
      }
    };
    rec.onerror = () => {
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
      setListening(false);
    };
    recognitionRef.current = rec;
    rec.start();
    setListening(true);
    setError(null);
  }, [listening, send]);

  const selectSession = useCallback((id: string) => {
    // Navigation works even while a run is in flight — the SSE stream stays
    // attached server-side and reattachRun() re-joins it when we come back
    // (or from another device). Blocking on `busy` is what made the sidebar
    // feel dead during work (the old `if (busy) return`).
    if (id === activeId) return;
    dbg("nav", `selectSession -> ${id} (was ${activeId})`, { busy: busyRef.current, streamSession: streamSessionRef.current });
    // Preserve the unsent draft of the conversation we're leaving.
    if (activeId) draftsRef.current[activeId] = input;
    // Save the current session's live state so we can restore it when the
    // user comes back — an active stream keeps its place in the UI.
    if (activeId) {
      liveBySessionRef.current[activeId] = { live, streamedText };
    }
    setActiveId(id);
    setMessages([]);
    setStreamedText("");
    setLive(IDLE_LIVE);
    // Entering a session is a new display generation — a stale
    // moduleFinalAppended=true from a previous completed run on this session
    // must not suppress the live bubble of a run we reattach to.
    bumpRunGen(id);
    // Restore this session's live state if it has one (background stream).
    const saved = liveBySessionRef.current[id];
    if (saved) {
      setLive(saved.live);
      setStreamedText(saved.streamedText);
    }
    // Await the load so the sidebar doesn't briefly show the wrong conversation.
    void loadMessages(id);
    // If the session we switched INTO is live — OR its module snapshot is
    // still un-settled (mid-flight or finished-without-settle) — reattach so
    // the run either continues or settles cleanly (never infinite spinners).
    const sess = sessions.find((s) => s.id === id);
    const snap = moduleLive[id];
    const snapActive = snap && snap.live.phase !== "idle" && snap.live.phase !== "done";
    if (sess?.is_active || snapActive || liveBySessionRef.current[id]) {
      void reattachRun(id);
    }
    // On mobile the sidebar fills the whole view — close it after picking
    // so the conversation is visible. Desktop keeps it open.
    if (window.innerWidth < 768) setSidebarOpen(false);
  }, [activeId, loadMessages, input, live, streamedText, sessions, reattachRun]);

  const deleteSession = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await fetch(`/api/chat/sessions/${id}`, { method: "DELETE" });
      delete draftsRef.current[id];
      const list = await loadSessions();
      if (id === activeId) {
        if (list.length > 0) {
          setActiveId(list[0].id);
          loadMessages(list[0].id);
        } else {
          setActiveId(null);
          setMessages([]);
        }
      }
    } catch (err: any) {
      setError(`Delete failed: ${err?.message ?? err}`);
    }
  }, [activeId, loadSessions, loadMessages]);

  const renameSession = useCallback(
    async (id: string, title: string) => {
      try {
        await fetch(`/api/chat/sessions/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        });
        await loadSessions();
      } catch (err: any) {
        setError(`Rename failed: ${err?.message ?? err}`);
      }
    },
    [loadSessions]
  );

  // ── Multi-select delete ─────────────────────────────────────────────
  // Long-press (mobile) or the select toggle (desktop) enters selection
  // mode; checkboxes appear and multiple conversations can be deleted at
  // once. Tap outside / X exits without deleting.
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggered = useRef(false);

  const startLongPress = useCallback((id: string) => {
    longPressTriggered.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressTriggered.current = true;
      setSelectMode(true);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    }, 450);
  }, []);

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const exitSelectMode = useCallback(() => {
    cancelLongPress();
    setSelectMode(false);
    setSelectedIds(new Set());
  }, [cancelLongPress]);

  const deleteSelected = useCallback(async () => {
    if (selectedIds.size === 0) return;
    setDeleting(true);
    try {
      await Promise.all(
        [...selectedIds].map((id) =>
          fetch(`/api/chat/sessions/${id}`, { method: "DELETE" })
        )
      );
      selectedIds.forEach((id) => delete draftsRef.current[id]);
      const list = await loadSessions();
      if (selectedIds.has(activeId ?? "")) {
        if (list.length > 0) {
          setActiveId(list[0].id);
          loadMessages(list[0].id);
        } else {
          setActiveId(null);
          setMessages([]);
        }
      }
      exitSelectMode();
    } catch (err: any) {
      setError(`Delete failed: ${err?.message ?? err}`);
    } finally {
      setDeleting(false);
    }
  }, [selectedIds, activeId, loadSessions, loadMessages, exitSelectMode]);

  const renderLiveContent = () => {
    if (live.phase === "idle") return null;
    // Once the final assistant message has been appended (assistant.completed),
    // the live bubble is redundant — the final bubble already carries the full
    // reasoning + tool chain + content. Stop rendering it so the reply never
    // appears twice (final bubble + live bubble). Generation-tagged: a stale
    // flag from a previous run on this session can't suppress a NEW run's
    // live bubble (bumpRunGen resets it on every send and session entry).
    if (activeId && isFinalAppendedForCurrentRun(activeId)) return null;
    const showReasoning =
      live.reasoning && settings.reasoning !== "hidden";

    const usingBrowser = live.tools.some(
      (t) =>
        t.name.includes("browser") ||
        t.name.includes("web_extract") ||
        t.name.includes("web_search")
    );

    // Ordered chain: reasoning and tool calls interleaved in the exact
    // sequence they happened (reasoning → tool → reasoning → tool → answer).
    // The chain persists across phase flips, so nothing disappears when the
    // run moves from thinking to tools to streaming.
    const chainSegments = live.chain.length > 0 ? live.chain : live.reasoning ? [{ kind: "reasoning" as const, text: live.reasoning }] : [];

    // Inline view caps at the most recent 3 TOOL segments (keeping the
    // reasoning that leads into them); the fullscreen chain shows everything
    // in order. Cap by finding the index of the 3rd-last tool segment.
    let inlineSegments = chainSegments;
    if (chainSegments.length > 4) {
      const toolIdx = chainSegments
        .map((s, i) => (s.kind === "tool" ? i : -1))
        .filter((i) => i >= 0);
      if (toolIdx.length > 3) {
        inlineSegments = chainSegments.slice(toolIdx[toolIdx.length - 3]);
      }
    }

    return (
      <div className="flex justify-start">
        <div className="max-w-[88%] min-w-0 rounded-2xl border px-4 py-2.5 text-sm" style={{ borderColor: "var(--card-border)", background: "color-mix(in srgb, var(--bg) 60%, transparent)", color: "var(--text)" }}>
          {usingBrowser && <BrowserView />}
          {inlineSegments.length > 0 && (
            <div className="mb-2 space-y-2">
              {inlineSegments.map((seg, i) =>
                seg.kind === "reasoning" ? (
                  settings.reasoning !== "hidden" ? (
                  <div
                    key={`r-${i}`}
                    className="whitespace-pre-wrap rounded-lg border-l-2 px-2.5 py-1.5 text-xs leading-relaxed"
                    style={{ borderLeftColor: "var(--accent)", background: "rgba(124,108,255,0.06)", color: "var(--text-dim)", maxHeight: 240, overflowY: "auto" }}
                  >
                    {settings.reasoning === "partial" && seg.text.length > 900 ? seg.text.slice(-900) : seg.text}
                    {settings.reasoning === "partial" && seg.text.length > 900 && (
                      <div className="mt-1 text-[10px] italic opacity-60">(preview mode — showing tail)</div>
                    )}
                  </div>
                  ) : null
                ) : (
                  <div key={`t-${i}`} className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs" style={{ borderColor: "var(--card-border)", color: "var(--text-dim)" }}>
                    {seg.tool.durationMs !== undefined ? (
                      seg.tool.error ? <span style={{ color: "var(--red)" }}>✕</span> : <span style={{ color: "var(--green)" }}>✓</span>
                    ) : (
                      <Loader2 className="h-3 w-3 animate-spin" style={{ color: "var(--accent)" }} />
                    )}
                    <span className="truncate">{seg.tool.name.replace(/_/g, " ")}</span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] opacity-70">
                      {seg.tool.durationMs !== undefined
                        ? (seg.tool.durationMs / 1000).toFixed(1)
                        : Math.max(0, (Date.now() - (seg.tool.startedAt ?? Date.now())) / 1000).toFixed(1)}
                      s
                    </span>
                  </div>
                )
              )}
              {chainSegments.length > 0 && (
                <button
                  onClick={() => setChainOpen(true)}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[10px] font-semibold"
                  style={{ borderColor: "var(--card-border)", color: "var(--text-faint)" }}
                >
                  <Maximize2 className="h-3 w-3" />
                  View full chain ({live.tools.length} tool call{live.tools.length === 1 ? "" : "s"})
                </button>
              )}
            </div>
          )}
          {live.phase === "streaming" && streamedText && (
            <div className="whitespace-pre-wrap break-words">
              <MarkdownLite text={streamedText} />
            </div>
          )}
          {live.phase !== "streaming" && live.phase !== "done" && (
            <div className="flex items-center gap-2 text-xs" style={{ color: "var(--text-faint)" }}>
              <span className="flex gap-0.5">
                <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-current" />
                <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-current" />
                <span className="thinking-dot h-1.5 w-1.5 rounded-full bg-current" />
              </span>
              {live.phase === "initializing" ? "Initializing agent…" : live.phase === "thinking" ? "Thinking…" : "Working…"}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="mx-auto flex h-[calc(100dvh-170px)] min-h-[480px] max-w-5xl flex-col" style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <MessageSquare className="h-6 w-6" style={{ color: "var(--accent)" }} /> Chat + Voice
        </h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border"
            style={{ borderColor: "var(--card-border)", color: "var(--text-dim)" }}
            title="Conversations"
            aria-label="Toggle conversations sidebar"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            {sidebarOpen ? <ChevronLeft className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
          <ChatSettingsButton settings={settings} onChange={setSettings} />
          <button
            onClick={newConversation}
            disabled={false}
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
          >
            <Plus className="h-4 w-4" /> New conversation
          </button>
        </div>
      </div>

      <div className="card relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1">
          {/* Conversation sidebar — mobile: slides in as a full-height overlay;
              desktop (md+): an IN-FLOW collapsible column (~30% width, capped)
              like ChatGPT — the chat cell shrinks to the remaining width
              instead of being covered. */}
          <div
            className={`absolute md:relative ${sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"} w-full transition-all duration-200 ease-out ${
              sidebarOpen ? "md:w-[30%] md:max-w-[300px] md:min-w-[220px]" : "md:w-0 md:max-w-0 md:overflow-hidden"
            } ${sidebarOpen ? "" : "md:hidden"}`}
            style={{
              top: 0,
              left: 0,
              height: "100%",
              zIndex: 10,
              display: "flex",
              flexDirection: "column",
              background: "color-mix(in srgb, var(--bg-2) 97%, transparent)",
              backdropFilter: "blur(2px)",
              borderRight: sidebarOpen ? "1px solid var(--card-border)" : "none",
            }}
          >
              <div className="flex items-center justify-between px-3 py-2">
                {selectMode ? (
                  <>
                    <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--accent)" }}>
                      {selectedIds.size} selected
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={deleteSelected}
                        disabled={deleting || selectedIds.size === 0}
                        className="flex items-center gap-1 rounded px-2 py-1 text-[10px] font-semibold"
                        style={{ color: "var(--red)", background: "rgba(255,80,80,0.1)" }}
                        aria-label="Delete selected"
                      >
                        {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                        Delete
                      </button>
                      <button
                        onClick={exitSelectMode}
                        className="rounded p-1"
                        style={{ color: "var(--text-faint)" }}
                        aria-label="Cancel selection"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-dim)" }}>
                      Conversations
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setSelectMode(true)}
                        className="rounded p-1"
                        style={{ color: "var(--text-faint)" }}
                        aria-label="Select conversations"
                        title="Select multiple"
                      >
                        <CheckSquare className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => setSidebarOpen(false)}
                        className="rounded p-1"
                        style={{ color: "var(--text-faint)" }}
                        aria-label="Hide sidebar"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </button>
                    </div>
                  </>
                )}
              </div>
              <div className="flex gap-1 px-2 pb-1">
                {(["chats", "all"] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => {
                      setSessionFilter(f);
                      setSessionsLoading(true);
                      loadSessions(f);
                    }}
                    className="flex-1 rounded-lg px-2 py-1 text-[10px] font-semibold uppercase tracking-wide"
                    style={
                      sessionFilter === f
                        ? { background: "rgba(124,108,255,0.14)", color: "var(--accent)" }
                        : { color: "var(--text-faint)" }
                    }
                  >
                    {f === "chats" ? "Chats" : "All"}
                  </button>
                ))}
              </div>
              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
                {sessionsLoading ? (
                  <SessionListSkeleton />
                ) : (sessionFilter === "chats"
                    ? sessions.filter((s) => {
                        // Only show conversations started from this dashboard (dashboard source or
                        // no source = legacy sessions). Exclude cron, subagent, dispatch, system, etc.
                        const src = s.source ?? "";
                        return src === "" || src === "dashboard";
                      })
                    : sessions
                  ).length === 0 ? (
                  <div className="px-2 py-4 text-xs" style={{ color: "var(--text-faint)" }}>
                    {sessionFilter === "chats"
                      ? "No dashboard conversations yet — start one with New conversation."
                      : "No conversations yet."}
                  </div>
                ) : (
                  (sessionFilter === "chats"
                    ? sessions.filter((s) => {
                        const src = s.source ?? "";
                        return src === "" || src === "dashboard";
                      })
                    : sessions
                  ).map((s) => (
                    <div
                      key={s.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        if (selectMode) {
                          toggleSelect(s.id);
                          return;
                        }
                        if (longPressTriggered.current) {
                          longPressTriggered.current = false;
                          return;
                        }
                        selectSession(s.id);
                      }}
                      onKeyDown={(e) => e.key === "Enter" && (selectMode ? toggleSelect(s.id) : selectSession(s.id))}
                      onPointerDown={() => {
                        if (!selectMode) startLongPress(s.id);
                      }}
                      onPointerUp={cancelLongPress}
                      onPointerLeave={cancelLongPress}
                      onPointerCancel={cancelLongPress}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        if (!selectMode) {
                          setSelectMode(true);
                          setSelectedIds((prev) => {
                            const next = new Set(prev);
                            next.add(s.id);
                            return next;
                          });
                        }
                      }}
                      className="group relative w-full cursor-pointer rounded-lg px-3 py-2 text-left text-xs"
                      style={
                        selectMode
                          ? selectedIds.has(s.id)
                            ? { background: "rgba(124,108,255,0.18)", color: "var(--text)" }
                            : { color: "var(--text-dim)" }
                          : s.id === activeId
                            ? { background: "rgba(124,108,255,0.12)", color: "var(--text)" }
                            : { color: "var(--text-dim)" }
                      }
                    >
                      {selectMode && (
                        <span className="mr-2 inline-flex align-middle">
                          {selectedIds.has(s.id) ? (
                            <CheckSquare className="h-4 w-4" style={{ color: "var(--accent)" }} />
                          ) : (
                            <Square className="h-4 w-4" style={{ color: "var(--text-faint)" }} />
                          )}
                        </span>
                      )}
                      {editingTitle === s.id ? (
                        <input
                          autoFocus
                          value={titleDraft}
                          onChange={(e) => setTitleDraft(e.target.value)}
                          onBlur={() => {
                            if (titleDraft.trim()) renameSession(s.id, titleDraft.trim());
                            setEditingTitle(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              if (titleDraft.trim()) renameSession(s.id, titleDraft.trim());
                              setEditingTitle(null);
                            }
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="w-full rounded border bg-transparent px-1 py-0.5 text-xs outline-none"
                          style={{ borderColor: "var(--accent)", color: "var(--text)" }}
                        />
                      ) : (
                        <>
                          <div className="flex items-center gap-1.5 truncate font-medium">
                            {s.is_active && (
                              <Loader2 className="h-3 w-3 shrink-0 animate-spin" style={{ color: "var(--accent)" }} />
                            )}
                            <span className="truncate">{s.title || s.last_message || s.id.slice(0, 20)}</span>
                          </div>
                          <div className="mt-0.5 flex items-center gap-2 text-[10px]" style={{ color: "var(--text-faint)" }}>
                            {s.is_active && (
                              <span className="flex items-center gap-1 font-semibold" style={{ color: "var(--accent)" }}>
                                <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: "var(--accent)" }} />
                                Working…
                              </span>
                            )}
                            <span>{s.message_count ?? 0} msgs</span>
                            {s.tool_call_count != null && <span>· {s.tool_call_count} tools</span>}
                          </div>
                        </>
                      )}
                      {editingTitle !== s.id && !selectMode && (
                        <div className="absolute right-1 top-1 hidden gap-0.5 group-hover:flex">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingTitle(s.id);
                              setTitleDraft(s.title || "");
                            }}
                            className="rounded p-1 hover:bg-white/10"
                            style={{ color: "var(--text-faint)" }}
                            aria-label="Rename"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button
                            onClick={(e) => deleteSession(s.id, e)}
                            className="rounded p-1 hover:bg-white/10"
                            style={{ color: "var(--red)" }}
                            aria-label="Delete"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>

          {/* Messages */}
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Profile switcher — who am I talking to. Switching loads that
                profile's conversations (Hermes multiplex /p/<profile>/). */}
            <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-1.5" style={{ borderColor: "var(--card-border)" }}>
              <span className="mr-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
                <Bot className="h-3.5 w-3.5" style={{ color: "var(--accent)" }} /> Talking to
              </span>
              <select
                value={profile}
                onChange={(e) => {
                  const next = e.target.value;
                  setProfile(next);
                  setMessages([]);
                  setStreamedText("");
                  setLive(IDLE_LIVE);
                  setBusy(false);
                  setActiveId(null);
                  setSessionsLoading(true);
                  loadSessions().then((list) => {
                    if (list.length > 0) {
                      setActiveId(list[0].id);
                      loadMessages(list[0].id);
                    } else {
                      setMessagesLoading(false);
                    }
                  });
                }}
                className="rounded-lg border bg-transparent px-2 py-1 text-xs font-semibold outline-none"
                style={{ borderColor: "var(--card-border)", color: "var(--accent-2)" }}
                aria-label="Switch profile"
              >
                {PROFILES.map((p) => (
                  <option key={p.id || "default"} value={p.id}>
                    {p.label} — {p.role}
                  </option>
                ))}
              </select>
              {profile !== "" && (
                <span className="text-[10px]" style={{ color: "var(--text-faint)" }}>
                  {profileLabel(profile)} profile — separate conversations, separate memory
                </span>
              )}
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              {messagesLoading ? (
                <MessageSkeleton />
              ) : messages.length === 0 && !busy ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-sm" style={{ color: "var(--text-faint)" }}>
                  <MessageSquare className="h-8 w-8 opacity-40" />
                  <span>Ask me anything — type below or tap the mic to speak.</span>
                  <span className="font-mono text-xs opacity-60">Tip: type <span style={{ color: "var(--accent)" }}>/</span> for commands</span>
                </div>
              ) : (
                <>
                  {messages.map((m, i) => (
                    <MessageBubble key={`${m.role}-${i}`} msg={m} settings={settings} />
                  ))}
                  {busy && <PhaseBanner phase={live.phase} toolCount={live.toolCount} elapsedSec={elapsedSec} />}
                  {busy && renderLiveContent()}
                </>
              )}
              <div ref={bottomRef} />
            </div>

            {chainOpen && (
              <ChainView
                reasoning={live.reasoning}
                toolCalls={[]}
                liveTools={live.tools}
                chain={live.chain}
                content={streamedText}
                onClose={() => setChainOpen(false)}
              />
            )}

            {error && (
              <div className="border-t px-4 py-2 text-xs" style={{ borderColor: "var(--card-border)", color: "var(--red)" }}>
                {error}
              </div>
            )}

            {/* Composer — extracted component so typing doesn't re-render the
                whole page (sidebar + messages). Fixes textbox lag. */}
            <Composer
              input={input}
              setInput={setInput}
              send={send}
              busy={busy}
              stopRun={stopRun}
              activeId={activeId}
              listening={listening}
              toggleMic={toggleMic}
              composerExpanded={composerExpanded}
              setComposerExpanded={setComposerExpanded}
              voiceOn={voiceOn}
              setVoiceOn={setVoiceOn}
              attachments={attachments}
              setAttachments={setAttachments}
            />

            {/* Composer — expanded: fills the chat container (not the viewport).
                Solid overlay matching the conversations sidebar so text is
                readable and never shows the busy stream behind it. */}
            {composerExpanded && (
              <div
                className="absolute inset-0 z-20 flex flex-col"
                style={{ background: "var(--bg-2)", borderColor: "var(--card-border)" }}
              >
                <div className="flex items-center justify-between border-b px-4 py-2" style={{ borderColor: "var(--card-border)" }}>
                  <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-dim)" }}>
                    Composer — full view
                  </span>
                  <button
                    onClick={() => setComposerExpanded(false)}
                    className="flex h-8 w-8 items-center justify-center rounded-lg border"
                    style={{ borderColor: "var(--card-border)", color: "var(--text-dim)" }}
                    aria-label="Collapse composer"
                    title="Collapse composer"
                  >
                    <Minimize2 className="h-4 w-4" />
                  </button>
                </div>
                <textarea
                  autoFocus
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send(input);
                    }
                  }}
                  placeholder={activeId ? "Message Hermes…  (type / for commands)" : "Type your first message to start…"}
                  disabled={false}
                  className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 text-sm leading-relaxed outline-none disabled:opacity-50"
                  style={{ color: "var(--text)" }}
                />
                <div className="flex items-center gap-2 border-t px-4 py-3" style={{ borderColor: "var(--card-border)" }}>
                  <button
                    onClick={toggleMic}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
                    style={listening ? { background: "var(--red)", color: "#fff" } : { background: "rgba(124,108,255,0.12)", color: "var(--accent)" }}
                    aria-label="Voice input"
                  >
                    {listening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                  </button>
                  <button
                    onClick={() => (busy ? stopRun() : send(input))}
                    disabled={!busy && !input.trim()}
                    className="flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-semibold text-white disabled:opacity-50"
                    style={{ background: busy ? "rgba(255,92,92,0.85)" : "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
                    aria-label={busy ? "Stop" : "Send"}
                  >
                    {busy ? <Square className="h-4 w-4" /> : <Send className="h-4 w-4" />}
                    {busy ? "Stop" : "Send"}
                  </button>
                  <span className="ml-auto text-[10px]" style={{ color: "var(--text-faint)" }}>
                    Enter to send · Shift+Enter for newline
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
