"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  Send, Mic, MicOff, Volume2, MessageSquare, Plus, ChevronLeft, ChevronRight,
  Loader2, Trash2, Pencil, Square, CheckSquare, X, Maximize2, Minimize2, Bot,
  CheckCircle2, XCircle,
} from "lucide-react";
import type { ChatMsg, ChatSettings, StreamEvent, ToolEvent, ChainSegment, RunStats, ToolCallInfo, ChatSegment } from "@/lib/chat-types";
import { useSessions } from "@/lib/use-sessions";
import { PROFILES, profileLabel, type ChatProfile } from "@/lib/profiles";
import { MessageBubble, MarkdownLite } from "@/components/chat/MessageBubble";
import { ChatSettingsButton, DEFAULT_SETTINGS, loadSettings } from "@/components/chat/ChatSettings";
import { Composer, type PendingAttachment } from "@/components/chat/Composer";
import { PhaseBanner, type RunPhase } from "@/components/chat/RunStatus";
import { MessageSkeleton, SessionListSkeleton } from "@/components/chat/Skeleton";
import { BrowserView } from "@/components/chat/BrowserView";
import { ChainView } from "@/components/chat/ChainView";
import { ToolCallStack } from "@/components/chat/ToolCalls";
import { DEFAULT_MODEL as MODEL } from "@/lib/models";
import { lastModelPick } from "@/components/chat/SlashAutocomplete";
import { mintStreamTicket, directStreamUrl, directStreamHeaders } from "@/lib/direct-stream";
import { dbg, toolSnap, liveSnap } from "@/lib/chat-debug";
import { watchRunCompletion } from "@/lib/push";

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
// Last completed run's per-reply usage per session (from run.completed).
// The DB does NOT persist per-message input/output — only the live SSE
// carries it — so the last reply's numbers are cached here and re-applied
// when a history reload rebuilds the final bubble.
const moduleLastUsage: Record<string, { input_tokens?: number; output_tokens?: number; model?: string } | undefined> = {};
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

// A module snapshot covers SPA navigation, but an installed PWA can be fully
// killed between frames. localStorage is intentionally used instead of
// sessionStorage: mobile browsers may discard the browsing session when the
// standalone app is closed. Only the currently selected conversation is
// retained, bounded by the browser's origin quota and expired after 24 hours.
const CHAT_RESUME_KEY = "hermes-chat-resume-v2";
const CHAT_RESUME_TTL_MS = 24 * 60 * 60 * 1000;

type PersistedChatResume = {
  version: 2;
  savedAt: number;
  sessionId: string;
  profile: string;
  messages: ChatMsg[];
  snapshot: ModuleLiveState;
  finalAppended: boolean;
  runGen: number;
};

function readPersistedChatResume(): PersistedChatResume | null {
  if (typeof window === "undefined") return null;
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(CHAT_RESUME_KEY) ?? "null");
    const candidate = parsed as Partial<PersistedChatResume> | null;
    const savedAt = candidate?.savedAt;
    const age = typeof savedAt === "number" ? Date.now() - savedAt : Number.POSITIVE_INFINITY;
    const snapshot = candidate?.snapshot as Partial<ModuleLiveState> | undefined;
    const persistedLive = snapshot?.live as Partial<LiveState> | undefined;
    const validMessages =
      Array.isArray(candidate?.messages) &&
      candidate.messages.every(
        (message) =>
          !!message &&
          typeof message === "object" &&
          (message.role === "user" || message.role === "assistant" || message.role === "system") &&
          typeof message.content === "string"
      );
    const validTools =
      Array.isArray(persistedLive?.tools) &&
      persistedLive.tools.every(
        (tool) =>
          !!tool &&
          typeof tool === "object" &&
          typeof tool.name === "string" &&
          typeof tool.startedAt === "number" &&
          Number.isFinite(tool.startedAt)
      );
    const validChain =
      Array.isArray(persistedLive?.chain) &&
      persistedLive.chain.every(
        (segment) =>
          !!segment &&
          typeof segment === "object" &&
          (segment.kind === "reasoning"
            ? typeof segment.text === "string"
            : segment.kind === "tool" && !!segment.tool && typeof segment.tool.name === "string")
      );
    const validPhase =
      typeof persistedLive?.phase === "string" &&
      ["idle", "initializing", "thinking", "tools", "streaming", "done", "error"].includes(persistedLive.phase);
    if (
      !candidate ||
      candidate.version !== 2 ||
      typeof candidate.sessionId !== "string" ||
      !candidate.sessionId ||
      typeof candidate.profile !== "string" ||
      !validMessages ||
      !snapshot ||
      !persistedLive ||
      !validTools ||
      !validChain ||
      !validPhase ||
      typeof persistedLive.reasoning !== "string" ||
      typeof persistedLive.toolCount !== "number" ||
      typeof persistedLive.failedCount !== "number" ||
      typeof snapshot.streamedText !== "string" ||
      typeof snapshot.busy !== "boolean" ||
      typeof snapshot.lastSeq !== "number" ||
      !Number.isFinite(snapshot.lastSeq) ||
      snapshot.lastSeq < 0 ||
      !Number.isFinite(age) ||
      age < -60_000 ||
      age > CHAT_RESUME_TTL_MS
    ) {
      window.localStorage.removeItem(CHAT_RESUME_KEY);
      return null;
    }
    return candidate as PersistedChatResume;
  } catch {
    window.localStorage.removeItem(CHAT_RESUME_KEY);
    return null;
  }
}

function persistChatResume(
  sessionId: string,
  profile: string,
  messages: ChatMsg[]
): void {
  if (typeof window === "undefined") return;
  const current = getModuleLive(sessionId);
  const lastSeq = Math.max(lastSeqState[sessionId] ?? 0, current.lastSeq ?? 0);
  // The module mirror is advanced synchronously with each parsed SSE frame.
  // React may not have committed that frame when pagehide fires, so persisting
  // render-captured props here would pair a NEW seq with OLD text/chain and
  // permanently skip the missing frame after reload.
  const snapshot: ModuleLiveState = {
    live: current.live,
    streamedText: current.streamedText,
    busy: current.busy,
    streamSession: current.busy ? sessionId : null,
    lastSeq,
  };
  moduleLive[sessionId] = snapshot;
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  // Never persist the suppression bit ahead of the actual final bubble. If
  // pagehide lands between assistant.completed and React's message commit,
  // the restored live bubble remains visible instead of hiding the answer.
  const finalAppended =
    moduleFinalAppended[sessionId] === true &&
    !!lastAssistant &&
    lastAssistant.content === snapshot.streamedText;
  try {
    window.localStorage.setItem(
      CHAT_RESUME_KEY,
      JSON.stringify({
        version: 2,
        savedAt: Date.now(),
        sessionId,
        profile,
        messages,
        snapshot,
        finalAppended,
        runGen: moduleRunGen[sessionId] ?? 0,
      } satisfies PersistedChatResume)
    );
  } catch {
    // Storage quota/private mode: module scope still preserves SPA returns.
  }
}

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

function completeFirstMatchingTool(
  tools: ToolEvent[],
  name: string,
  update: (tool: ToolEvent) => ToolEvent
): ToolEvent[] {
  const index = tools.findIndex(
    (tool) => tool.name === name && (tool.durationMs === undefined || tool.interrupted)
  );
  if (index < 0) return tools;
  return tools.map((tool, toolIndex) => (toolIndex === index ? update(tool) : tool));
}

function completeFirstMatchingToolInChain(
  chain: ChainSegment[],
  name: string,
  update: (tool: ToolEvent) => ToolEvent
): ChainSegment[] {
  const index = chain.findIndex(
    (segment) =>
      segment.kind === "tool" &&
      segment.tool.name === name &&
      (segment.tool.durationMs === undefined || segment.tool.interrupted)
  );
  if (index < 0) return chain;
  return chain.map((segment, segmentIndex) =>
    segmentIndex === index && segment.kind === "tool"
      ? { ...segment, tool: update(segment.tool) }
      : segment
  );
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

// The persisted transcript is the heaviest subtree on this page. It changes
// only when a message is added/reconciled or display settings change — never
// for keystrokes, elapsed ticks, reasoning deltas, or streamed answer deltas.
type MessageHistoryProps = {
  messages: ChatMsg[];
  messagesLoading: boolean;
  busy: boolean;
  settings: ChatSettings;
};

const MessageHistory = memo(function MessageHistory({
  messages,
  messagesLoading,
  busy,
  settings,
}: MessageHistoryProps) {
  useEffect(() => {
    dbg("render", `MessageHistory commit messages=${messages.length} loading=${messagesLoading} busy=${busy}`);
  });

  if (messagesLoading) return <MessageSkeleton />;
  if (messages.length === 0 && !busy) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm" style={{ color: "var(--text-faint)" }}>
        <MessageSquare className="h-8 w-8 opacity-40" />
        <span>Ask me anything — type below or tap the mic to speak.</span>
        <span className="font-mono text-xs opacity-60">Tip: type <span style={{ color: "var(--accent)" }}>/</span> for commands</span>
      </div>
    );
  }
  return (
    <>
      {messages.map((message, index) => (
        <MessageBubble key={`${message.role}-${index}`} msg={message} settings={settings} />
      ))}
    </>
  );
}, (previous, next) =>
  previous.messages === next.messages &&
  previous.messagesLoading === next.messagesLoading &&
  previous.settings === next.settings &&
  // `busy` only changes this subtree's output for the empty-state prompt.
  // With a transcript present, reattach/settle busy flips must not revisit
  // every persisted bubble.
  (previous.messages.length > 0 || previous.busy === next.busy)
);

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
  const messagesRef = useRef<ChatMsg[]>(messages);
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
  const [settings, setSettings] = useState<ChatSettings>(DEFAULT_SETTINGS);
  const [streamedText, setStreamedText] = useState("");
  const [elapsedSec, setElapsedSec] = useState(0);
  const [retryTarget, setRetryTarget] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesViewportRef = useRef<HTMLDivElement>(null);
  // Keeps the transcript pinned to the newest message even when layout
  // finishes LATE (markdown/code/font reflow after the commit) — the
  // double-rAF pin alone loses that race on big transcripts and the PWA
  // opens at the top (2026-08-29).
  const viewportObserverRef = useRef<MutationObserver | null>(null);
  const followLatestRef = useRef(true);
  const recognitionRef = useRef<any>(null);
  const streamAbort = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const primaryStreamSessionRef = useRef<string | null>(null);
  const reattachAbort = useRef<AbortController | null>(null);

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
  // Sidebar mode: "chats" = real conversations (most recent, no cron);
  // "bots" = Grok-style contact list of multiplex profiles you can talk to
  // individually, plus create-new-bot.
  const [viewTab, setViewTab] = useState<"chats" | "bots">("chats");
  const [newBotOpen, setNewBotOpen] = useState(false);
  const [botForm, setBotForm] = useState({ name: "", description: "", model: "", provider: "openrouter" });
  const [botCreating, setBotCreating] = useState(false);
  const [botError, setBotError] = useState<string | null>(null);
  const [delegations, setDelegations] = useState<
    { id: string; state: string; role?: string | null; model?: string | null; goal?: string; dispatched_at?: number | null }[]
  >([]);
  // Assigned after loadMessages is declared so callbacks defined earlier
  // (openBot) can invoke it without a TDZ error.
  const loadMessagesRef = useRef<(id: string) => void>(() => {});
  // Live multiplex profiles from the state server (auto-shows any profile
  // created via `hermes profile create` — e.g. ox-alpha). Merged with the
  // static fallback list; deduped by id, live list wins.
  const [extraProfiles, setExtraProfiles] = useState<ChatProfile[]>([]);
  // The gateway's live default model (config.yaml model.default), fetched
  // with the profile list. Used for NEW default-profile sessions instead of
  // a hardcoded name — switching brains in Hermes config updates the
  // dashboard automatically.
  const [gatewayModel, setGatewayModel] = useState<string>("");

  // The model a NEW session / stream should pin. When a multiplex profile is
  // selected (ox-alpha, coder, ...), use THAT profile's configured model so
  // the chat actually runs on the profile's brain — never the hardcoded
  // default. The default profile (empty id) uses the gateway's LIVE
  // default_model (fetched with the profile list), falling back to the
  // static DEFAULT_MODEL only when the state server is unreachable.
  const allProfiles: ChatProfile[] = extraProfiles.length > 0 ? extraProfiles : PROFILES;
  const activeProfile = allProfiles.find((p) => p.id === profile);
  const effectiveModel = activeProfile?.model || (profile ? "" : gatewayModel || MODEL);
  const [restoreReady, setRestoreReady] = useState(false);
  const restoredSessionIdRef = useRef<string | null>(null);
  const initialReconcileStartedRef = useRef(false);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    dbg("render", `ChatPage commit active=${activeId ?? "new"} messages=${messages.length} busy=${busy} phase=${live.phase}`);
  });

  // Cold-start restore for an installed PWA. Hydrate the selected transcript,
  // live chain, text, phase, and seq cursor before any network reconciliation;
  // the first painted client state is therefore the state the user left.
  useEffect(() => {
    const requestedId = new URLSearchParams(window.location.search).get("resume");
    const resume = readPersistedChatResume();
    // An explicit /chat?resume=... navigation is authoritative. Never paint a
    // different locally persisted conversation while that target loads.
    if (resume && (!requestedId || requestedId === resume.sessionId)) {
      restoredSessionIdRef.current = resume.sessionId;
      moduleLive[resume.sessionId] = resume.snapshot;
      lastSeqState[resume.sessionId] = resume.snapshot.lastSeq;
      moduleFinalAppended[resume.sessionId] = resume.finalAppended;
      moduleRunGen[resume.sessionId] = resume.runGen;
      liveBySessionRef.current[resume.sessionId] = {
        live: resume.snapshot.live,
        streamedText: resume.snapshot.streamedText,
      };
      setProfile(resume.profile);
      activeIdRef.current = resume.sessionId;
      setActiveId(resume.sessionId);
      messagesRef.current = resume.messages;
      setMessages(resume.messages);
      setMessagesLoading(false);
      setLive(resume.snapshot.live);
      setStreamedText(resume.snapshot.streamedText);
      const resumableBusy =
        resume.snapshot.busy &&
        resume.snapshot.live.phase !== "idle" &&
        resume.snapshot.live.phase !== "done" &&
        resume.snapshot.live.phase !== "error";
      setBusy(resumableBusy);
      // A network reader cannot survive a process close. Keep the visual busy
      // state, but force reattachRun to establish a fresh reader from lastSeq.
      streamSessionRef.current = null;
    }
    setRestoreReady(true);
  }, [setActiveId, setProfile]);

  // Load display settings once.
  useEffect(() => {
    setSettings(loadSettings());
  }, []);

  // Fetch the live profile list once on mount. If the state server is
  // reachable it returns every profile dir under ~/.hermes/profiles/ so the
  // dropdown never goes stale when a new profile is created.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/chat/profiles", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const live = (d?.profiles ?? []) as { name: string; description?: string; model?: string }[];
        const byName = new Map(live.map((p) => [p.name, p]));
        // The gateway's active default model — live from config.yaml, never
        // hardcoded. Empty string = state server unreachable; the page then
        // falls back to the static DEFAULT_MODEL import.
        const dm = typeof d?.default_model === "string" ? d.default_model.trim() : "";
        if (dm) setGatewayModel(dm);
        // Enrich every known profile with its live model (coder, verifier, …),
        // and append any profile not in the static list (e.g. ox-alpha).
        const merged = PROFILES.map((p) => {
          const l = p.id ? byName.get(p.id) : undefined;
          return l?.model ? { ...p, model: l.model } : p;
        });
        const known = new Set(PROFILES.map((p) => p.id));
        const extras = live
          .filter((p) => p.name && !known.has(p.name))
          .map((p) => ({
            id: p.name,
            label: p.name
              .split(/[-_]/)
              .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
              .join(" "),
            role: p.description || (p.model ? `Model: ${p.model}` : "Custom profile"),
            model: p.model || undefined,
          }));
        setExtraProfiles([...merged, ...extras]);
      })
      .catch(() => {
        /* state server unreachable — keep the static list */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch recent subagent delegations so the Chats view can show a "what my
  // subagents did" rundown (the work they were assigned shows up here).
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch("/api/chat/delegations", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => {
          if (!cancelled) setDelegations((d?.delegations ?? []).slice(0, 8));
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const createBot = useCallback(async () => {
    const name = botForm.name.trim().toLowerCase();
    if (!name || botCreating) return;
    setBotCreating(true);
    setBotError(null);
    try {
      const res = await fetch("/api/chat/profiles/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: botForm.description.trim(),
          model: botForm.model.trim(),
          provider: botForm.provider,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setBotError(data.error ?? `create failed (${res.status})`);
        return;
      }
      setBotForm({ name: "", description: "", model: "", provider: "openrouter" });
      setNewBotOpen(false);
      // Refresh the profile list so the new bot appears in the dropdown/contact list.
      fetch("/api/chat/profiles", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => {
          const live = (d?.profiles ?? []) as { name: string; description?: string; model?: string }[];
          const byName = new Map(live.map((p) => [p.name, p]));
          const merged = PROFILES.map((p) => {
            const l = p.id ? byName.get(p.id) : undefined;
            return l?.model ? { ...p, model: l.model } : p;
          });
          const known = new Set(PROFILES.map((p) => p.id));
          const extras = live
            .filter((p) => p.name && !known.has(p.name))
            .map((p) => ({
              id: p.name,
              label: p.name
                .split(/[-_]/)
                .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                .join(" "),
              role: p.description || (p.model ? `Model: ${p.model}` : "Custom profile"),
              model: p.model || undefined,
            }));
          setExtraProfiles([...merged, ...extras]);
        })
        .catch(() => {});
    } catch (e) {
      setBotError(e instanceof Error ? e.message : String(e));
    } finally {
      setBotCreating(false);
    }
  }, [botForm, botCreating]);

  // Opening a bot (profile) in the chat — switches the profile, starts a
  // fresh conversation for it, and routes future sends to /p/<profile>/.
  const openBot = useCallback(
    (botId: string) => {
      if (botId === profile) return;
      setProfile(botId);
      setMessages([]);
      setStreamedText("");
      setLive(IDLE_LIVE);
      setBusy(false);
      setActiveId(null);
      setSessionsLoading(true);
      // Pass botId explicitly — setProfile is async and loadSessions reads
      // profile from the hook state, which would still be the OLD profile.
      loadSessions(undefined, botId).then((list) => {
        if (list.length > 0) {
          setActiveId(list[0].id);
          // loadMessages is declared below; call it via the ref set at runtime.
          loadMessagesRef.current(list[0].id);
        } else {
          setMessagesLoading(false);
        }
      });
      if (window.innerWidth < 768) setSidebarOpen(false);
    },
    [profile, loadSessions, setProfile]
  );

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
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // Persist at most once per burst of SSE/UI updates. pagehide and hidden
  // visibility flush synchronously so the last delta/seq survives an app kill.
  useEffect(() => {
    if (!restoreReady || !activeId) return;
    const flush = () => persistChatResume(activeId, profile, messages);
    const timer = window.setTimeout(flush, 80);
    const onPageHide = () => flush();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [restoreReady, activeId, profile, messages, live, streamedText, busy]);

  const loadMessages = useCallback(async (id: string, showLoading = true, applyToView = true, profileOverride?: string) => {
    const requestedRunGen = moduleRunGen[id] ?? 0;
    if (showLoading && applyToView) setMessagesLoading(true);
    try {
      const selectedProfile = profileOverride ?? profile;
      const profileQs = selectedProfile ? `?profile=${encodeURIComponent(selectedProfile)}` : "";
      const res = await fetch(`/api/chat/sessions/${id}/messages${profileQs}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || data?.error) {
        throw new Error(data?.error?.message ?? data?.error ?? `messages failed (${res.status})`);
      }
      const list = data?.data ?? [];
      dbg("loadMessages", `GET /messages rows=${list.length} http=${res.status} profile=${profile ?? "default"}`, { sessionId: id });
      // Per-message model: prefer the session's ACTUAL model (the profile's
      // real brain), falling back to the effective profile model, then the
      // dashboard default. Never hardcode deepseek for a profile conversation.
      const sessionRow = (data as any)?.session ?? (list as any[])[0]?.session;
      const rowModel = sessionRow?.model ?? (data as any)?.model;
      const modelName = typeof rowModel === "string" && rowModel ? rowModel : effectiveModel || MODEL;
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
      // Index of the last assistant row in `list` — only that row carries the
      // cached per-reply usage (moduleLastUsage).
      const lastAssistantIdx = (() => {
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i]?.role === "assistant") return i;
        }
        return -1;
      })();
      let rowIdx = -1;
      for (const m of list) {
        rowIdx += 1;
        const isLastAssistantRow = rowIdx === lastAssistantIdx;
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
          // The LAST assistant row also gets the cached per-reply usage
          // (in/out from that turn's run.completed) — the DB doesn't store
          // per-message usage, so the live capture is the only source.
          stats:
            m.role === "assistant"
              ? {
                  model: modelName,
                  tokens: typeof m.token_count === "number" ? m.token_count : undefined,
                  ...(isLastAssistantRow
                    ? moduleLastUsage[id] ?? {}
                    : {}),
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
      if (
        applyToView &&
        activeIdRef.current === id &&
        (moduleRunGen[id] ?? 0) === requestedRunGen
      ) {
        const currentMessages = messagesRef.current;
        const snapshot = moduleLive[id];
        const localFinal = [...currentMessages].reverse().find((message) => message.role === "assistant")?.content;
        const serverFinal = [...msgs].reverse().find((message) => message.role === "assistant")?.content;
        const preserveRestoredFinal =
          !showLoading &&
          !!snapshot?.busy &&
          currentMessages.length >= msgs.length &&
          !!localFinal &&
          localFinal === snapshot.streamedText &&
          localFinal !== serverFinal;
        if (!preserveRestoredFinal) {
          messagesRef.current = msgs;
          setMessages(msgs);
          // A freshly opened/switched conversation must land on the newest
          // message, not the top. Reset the follow flag and pin AFTER the
          // commit — double-rAF so the (possibly huge) transcript has laid
          // out before we measure scrollHeight. Session switches previously
          // inherited a stale followLatestRef=false from scrolling in the
          // prior conversation, landing the user at the oldest message.
          followLatestRef.current = true;
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const viewport = messagesViewportRef.current;
              if (viewport && activeIdRef.current === id) {
                viewport.scrollTop = viewport.scrollHeight;
              }
            })
          );
        } else {
          dbg("loadMessages", "kept newer restored final while persistence catches up", { sessionId: id });
        }
      }
      dbg("loadMessages", `merged rows=${list.length} -> msgs=${msgs.length} toolResults=${toolResults.size}`, {
        sessionId: id,
        assistantMsgs: msgs.filter((m) => m.role === "assistant").length,
        toolMsgs: msgs.filter((m) => m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0).length,
      });
      // 2026-09-01 FIX (queue loss): restore a queued message that survived a
      // crash/reload while the page was away. Only when the page believes
      // it's NOT busy (nothing will flush the in-memory queue).
      try {
        const qKey = `hermes-chat-queue-${id}`;
        const persisted: string[] = JSON.parse(window.localStorage.getItem(qKey) ?? "[]");
        if (persisted.length && !busyRef.current && pendingQueue.current.length === 0) {
          pendingQueue.current.push(...persisted);
          dbg("loadMessages", `restored ${persisted.length} queued message(s) from localStorage`, { sessionId: id });
        }
      } catch {
        /* ignore */
      }
      return msgs;
    } catch (e) {
      dbg("loadMessages", `FAILED ${e instanceof Error ? e.message : e}`, { sessionId: id });
      if (applyToView && activeIdRef.current === id && (moduleRunGen[id] ?? 0) === requestedRunGen) {
        setError(`Failed to load messages: ${e instanceof Error ? e.message : e}`);
      }
      return [] as ChatMsg[];
    } finally {
      if (showLoading && applyToView && activeIdRef.current === id) setMessagesLoading(false);
    }
  }, [profile, effectiveModel]);

  // Wire the runtime ref used by earlier callbacks (openBot).
  loadMessagesRef.current = loadMessages;

  useEffect(() => {
    if (!restoreReady || initialReconcileStartedRef.current) return;
    initialReconcileStartedRef.current = true;
    const resumeId = new URLSearchParams(window.location.search).get("resume");
    const persistedId = restoredSessionIdRef.current;
    const requestedId = resumeId ?? persistedId;
    loadSessions(requestedId ? "all" : undefined).then((list) => {
      // If arriving via a Resume link (e.g. from /sessions), open that exact
      // session instead of the default most-recent one. Load with source=all
      // so cron/subagent sessions (not in the dashboard filter) resolve too.
      const target = requestedId ? list.find((s) => s.id === requestedId) : undefined;
      if (target) {
        activeIdRef.current = target.id;
        setActiveId(target.id);
        // The persisted transcript is already visible. Reconcile silently so
        // returning never flashes a skeleton over an intact conversation.
        loadMessages(target.id, target.id !== persistedId);
      } else if (list.length > 0) {
        activeIdRef.current = list[0].id;
        setActiveId(list[0].id);
        loadMessages(list[0].id);
      } else {
        setMessagesLoading(false);
      }
    });
  }, [restoreReady, loadSessions, loadMessages, setActiveId]);

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
    if (!busy) {
      setElapsedSec(0);
      return;
    }
    const started = live.stats?.startedAt ?? Date.now();
    const tick = () => setElapsedSec(Math.max(0, Math.floor((Date.now() - started) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [busy, live.stats?.startedAt]);

  const updateFollowLatest = useCallback(() => {
    const viewport = messagesViewportRef.current;
    if (!viewport) return;
    followLatestRef.current =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 96;
  }, []);

  const pinToLatest = useCallback(() => {
    followLatestRef.current = true;
    requestAnimationFrame(() => {
      const viewport = messagesViewportRef.current;
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
    });
  }, []);

  useEffect(() => {
    const viewport = messagesViewportRef.current;
    if (!viewport) return;
    const pinNow = () => {
      if (!settings.autoScroll || !followLatestRef.current) return;
      viewport.scrollTop = viewport.scrollHeight;
    };
    // (a) React-state-driven pin (existing behaviour).
    let frame = 0;
    if (settings.autoScroll && followLatestRef.current) {
      frame = requestAnimationFrame(pinNow);
    }
    // (b) Layout-driven pin: late reflow (fonts, code fences, images) grows
    // the transcript AFTER React's commit; observe and re-pin so the newest
    // message stays on screen regardless of what triggered the growth.
    const observer = new MutationObserver(() => requestAnimationFrame(pinNow));
    observer.observe(viewport, { childList: true, subtree: true, characterData: true });
    viewportObserverRef.current = observer;
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      viewportObserverRef.current = null;
    };
  }, [messages, busy, live, streamedText, settings.autoScroll]);

  // Keep the reasoning stream pinned to the bottom as it grows — the box is
  // height-capped and scrolls internally, so it must follow the newest text
  // instead of staying at the top.
  const newConversation = useCallback(async () => {
    // Lazy creation: don't POST a session yet — an empty conversation with
    // zero messages should never be saved. The session is created on the
    // first send() instead. Just clear the UI and arm the composer.
    setError(null);
    setLive(IDLE_LIVE);
    activeIdRef.current = null;
    setActiveId(null);
    setMessages([]);
    setStreamedText("");
    setInput("");
    setComposerExpanded(false);
    await loadSessions();
  }, [loadSessions, setActiveId]);

  // ── Slash command handling ──────────────────────────────────────────
  const sendRef = useRef<((text: string) => Promise<void>) | null>(null);

  const stopRun = useCallback(() => {
    const sessionId = activeIdRef.current;
    if (primaryStreamSessionRef.current === sessionId) {
      streamAbort.current?.abort("user-stop");
    }
    reattachAbort.current?.abort("user-stop");
    const now = Date.now();
    if (sessionId) {
      const snapshot = getModuleLive(sessionId);
      snapshot.live = settleLiveState(snapshot.live, now);
      snapshot.busy = false;
      snapshot.streamSession = null;
      liveBySessionRef.current[sessionId] = {
        live: snapshot.live,
        streamedText: snapshot.streamedText,
      };
      if (streamSessionRef.current === sessionId) streamSessionRef.current = null;
      // The browser is only a view; explicitly interrupt the real laptop run.
      void fetch("/api/chat/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "/stop", session_id: sessionId }),
      }).catch(() => {});
    }
    setLive((prev) => ({
      ...settleLiveState(prev, now),
      stats: {
        ...(prev.stats ?? { toolCount: 0, failedTools: 0, startedAt: now }),
        completedAt: now,
        durationMs: now - (prev.stats?.startedAt ?? now),
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
            activeIdRef.current = newId;
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
            setMessages((m) => [...m, { role: "system", content: `Usage: \`/model <name>\` — e.g. \`/model ${effectiveModel || MODEL}\`. Model locks the session (runtime verified server-side).` }]);
            return true;
          }
          try {
            const res = await fetch(`/api/chat/sessions/${activeId}/model`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(
                {
                  // 2026-09-02 FIX (--global poisoning): the raw arg could
                  // carry CLI scope flags ("glm-5.3-flash --global",
                  // "--provider x"). Persisting them into the model id made
                  // every later turn 404 upstream. Strip flag tokens here;
                  // the server's lock writer sanitizes too (defense in depth).
                  model: arg.split(/\s+--\w+/)[0].trim(),
                  require_model_lock: false,
                  // Track the provider the user picked in the wizard (when
                  // they picked from the dynamic list) so the gateway builds
                  // the correct provider route for non-aliased models.
                  ...(lastModelPick.providerSlug
                    ? { provider: lastModelPick.providerSlug }
                    : {}),
                  // "ultra" effort maps to high; explicit string passthrough.
                  ...(arg.toLowerCase().includes("ultra")
                    ? { model_options: { reasoning: { enabled: true, effort: "high" } } }
                    : {}),
                },
              ),
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
          const lastStats = liveRef.current.stats;
          const model = lastStats?.runtime?.model ?? (effectiveModel || MODEL);
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
              `Last reply: ${lastStats?.usage?.input_tokens?.toLocaleString() ?? "—"} in / ${lastStats?.usage?.output_tokens?.toLocaleString() ?? "—"} out`,
              "",
              "Lifetime (this session's whole history):",
              `Input tokens (cumulative): ${inp.toLocaleString()}`,
              `Output tokens (cumulative): ${out.toLocaleString()}`,
              `Total (cumulative): ${tot.toLocaleString()}`,
              `Cache read: ${cacheRead.toLocaleString()} · write: ${cacheWrite.toLocaleString()}`,
              `Reasoning tokens: ${reasoning.toLocaleString()}`,
              "Cumulative numbers add up over time (every turn re-sends context) — the per-reply line is what THIS conversation costs per message.",
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
          activeIdRef.current = target.id;
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
                activeIdRef.current = list[0].id;
                setActiveId(list[0].id);
                loadMessages(list[0].id);
              } else {
                activeIdRef.current = null;
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
          const lastStats = liveRef.current.stats;
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
          // 2026-09-01 FIX (queue loss): the queue was a plain in-memory ref —
          // a crash/reload/abort between /queue and the run finishing LOST the
          // text (this bit Akhil on 1 Sep 17:0x). Now mirrored to localStorage
          // per-session and restored on load; cleared only on actual flush.
          pendingQueue.current.push(arg);
          try {
            const qKey = `hermes-chat-queue-${activeId ?? "new"}`;
            const existing: string[] = JSON.parse(window.localStorage.getItem(qKey) ?? "[]");
            existing.push(arg);
            window.localStorage.setItem(qKey, JSON.stringify(existing));
          } catch {
            // quota/private mode: in-memory queue still works for this page's lifetime
          }
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
        case "insights":
        case "restart":
        case "update":
        case "platform":
        case "debug": {
          // Full command bridge — the state server runs read-only commands
          // locally (backed by real data) and routes the rest through the
          // native dashboard's WS RPC.
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
    [activeId, retryTarget, newConversation, loadSessions, loadMessages, sessions, stopRun, setVoiceOn, voiceOn]
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
            // Pin the session to the active model + profile. For a multiplex
            // profile (ox-alpha, coder, ...) use that profile's own model so
            // the chat runs on its brain; for the default profile pin the
            // dashboard default. Without a pin the API server persists its
            // virtual model name which beats the per-request model.
            body: JSON.stringify({ model: effectiveModel || undefined, profile }),
          });
          const data = await res.json();
          const id = data?.session?.id ?? data?.session_id ?? data?.data?.id;
          if (!id) throw new Error("No session id returned");
          sessionId = id;
          activeIdRef.current = id;
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
        // 2026-09-01 FIX (silent steer loss): the ack used to be pushed
        // BEFORE the fetch and failures were filtered out — a 409-bounced
        // steer rendered as "⏩ Steered". The ack now comes ONLY from the
        // server's actual response.
        let steerAck = "";
        try {
          const res = await fetch("/api/chat/command", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ command: `/steer ${trimmed}`, session_id: sessionId }),
          });
          const data = await res.json();
          steerAck =
            data?.output ??
            data?.error ??
            "⚠️ Steer could not be delivered — the run may have just finished. Send it as a normal message.";
        } catch {
          steerAck = "⚠️ Steer failed to send (network). Send it as a normal message instead.";
        }
        setMessages((m) => [
          ...m,
          { role: "user", content: trimmed },
          { role: "system", content: steerAck },
        ]);
        return;
      }

      // 2026-09-02 FIX (unattached-run steer): this tab may not be attached to
      // a LIVE run (reload, second device, missed run.started) while the
      // session's agent is actually mid-turn — busyRef is blind to that and a
      // plain send becomes a silently-queued second turn. Ask the state server
      // whether the session has a live run before choosing steer vs send.
      try {
        const probe = await fetch("/api/chat/command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: "/live", session_id: sessionId }),
        });
        const pdata = await probe.json().catch(() => null);
        if (pdata?.live) {
          // A run IS live server-side even though this tab isn't busy —
          // route through the real steer path so it lands at the next
          // tool boundary, and surface the server's honest ack.
          let steerAck = "";
          let steerFailed = false;
          try {
            const res = await fetch("/api/chat/command", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ command: `/steer ${trimmed}`, session_id: sessionId }),
            });
            const data = await res.json();
            steerAck = data?.output ?? "";
            // 2026-09-02 FIX (message loss): if the "live" run turned out to be
            // stale (completed between probe and steer — race), the steer fails
            // and the message must NOT be swallowed. Fall through to the normal
            // send path so it reaches the agent as a fresh turn.
            steerFailed = !steerAck || steerAck.includes("No live agent");
          } catch {
            steerFailed = true;
          }
          if (!steerFailed) {
            setMessages((m) => [
              ...m,
              { role: "user", content: trimmed },
              { role: "system", content: steerAck || "⏩ Steered." },
            ]);
            return;
          }
          // fall through to normal send below
        }
      } catch {
        // Probe failure = fall through to normal send (never block a message).
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
      const startedAt = Date.now();
      const initialLive: LiveState = {
        phase: "initializing",
        reasoning: "",
        tools: [],
        chain: [],
        stats: { toolCount: 0, failedTools: 0, startedAt, usage: null, runtime: null },
        toolCount: 0,
        failedCount: 0,
      };
      if (activeIdRef.current === sessionId) {
        pinToLatest();
        setMessages((current) => [...current, { role: "user", content: trimmed }]);
        setBusy(true);
        setLive(initialLive);
        setStreamedText("");
      }
      setError(null);
      bumpRunGen(sessionId);
      if (sessionId) {
        // The primary POST reader owns this session until its finally block.
        // Mark it explicitly so visibility/focus/session polling cannot open a
        // concurrent /events reader and race the same seq cursor.
        reattachAbort.current?.abort();
        streamSessionRef.current = sessionId;
        const m = getModuleLive(sessionId);
        m.busy = true;
        m.streamSession = sessionId;
        m.live = initialLive;
        m.streamedText = "";
        liveBySessionRef.current[sessionId] = { live: initialLive, streamedText: "" };
      }

      const abort = new AbortController();
      streamAbort.current = abort;
      primaryStreamSessionRef.current = sessionId;

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
      let currentLive = initialLive;
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
      let sawRunEvent = false;
      let terminalFailure = false;
      let runFinished = false;
      let completionWatchRegistered = false;
      let readerLastSeq = sessionId ? lastSeqState[sessionId] ?? 0 : 0;
      const baselineMessageCount = messagesRef.current.length;
      const baselineLastAssistant = [...messagesRef.current]
        .reverse()
        .find((message) => message.role === "assistant")?.content;

      const bumpLive = (patch: Partial<LiveState>) => {
        // SSE frames can arrive in one reader batch before React commits. Keep
        // one synchronous accumulator and mirror it before scheduling paint;
        // this also makes pagehide's seq/text/chain snapshot atomic.
        currentLive = { ...currentLive, ...patch };
        if (sessionId) {
          liveBySessionRef.current[sessionId] = { live: currentLive, streamedText: full };
          const m = getModuleLive(sessionId);
          m.live = currentLive;
          m.streamedText = full;
          m.lastSeq = lastSeqState[sessionId] ?? m.lastSeq;
        }
        if (activeIdRef.current === sessionId) setLive(currentLive);
      };

      try {
        // Prefer DIRECT-to-funnel streaming (ticket-gated): Vercel's function
        // cap kills SSE pipes mid-run; the funnel is a raw proxy with no cap.
        // Fall back to the Vercel route when a ticket can't be minted OR the
        // funnel doesn't answer headers within 8s (e.g. Chrome on the
        // Tailscale host itself can't hairpin to its own funnel — the phone
        // is the real client and has no such issue). The probe IS the real
        // stream request: if it answers headers in time we consume it as the
        // stream; if not, we abort it (which also frees the single-use
        // ticket — the upstream run just never started) and re-send through
        // the Vercel proxy.
        let res: Response;
        const ticket = sessionId ? await mintStreamTicket(String(sessionId)) : null;
        if (ticket) {
          const probe = new AbortController();
          const probeTimer = setTimeout(() => probe.abort(), 8000);
          let direct: Response | null = null;
          try {
            direct = await fetch(directStreamUrl(String(sessionId)), {
              method: "POST",
              headers: { ...directStreamHeaders(ticket), "Content-Type": "application/json" },
              body: JSON.stringify({ message: trimmed, model: effectiveModel || undefined, profile }),
              signal: probe.signal,
            });
          } catch {
            direct = null;
          } finally {
            clearTimeout(probeTimer);
          }
          if (direct && direct.ok && direct.body) {
            dbg("stream", "using DIRECT funnel stream", { sessionId });
            res = direct;
          } else {
            // Kill the direct attempt if it's still hanging; the ticket is
            // single-use and may be consumed server-side — the fallback
            // re-auths with the bridge token via the Vercel route.
            try { direct?.body?.cancel(); } catch {}
            dbg("stream", "funnel not answering — using Vercel proxy", { sessionId });
            res = await fetch(`/api/chat/sessions/${sessionId}/stream`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ message: trimmed, model: effectiveModel || undefined, profile }),
              signal: abort.signal,
            });
          }
        } else {
          dbg("stream", "ticket unavailable — using Vercel proxy", { sessionId });
          res = await fetch(`/api/chat/sessions/${sessionId}/stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: trimmed, model: effectiveModel || undefined, profile }),
            signal: abort.signal,
          });
        }
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
              lastSeqState[sessionId] = Math.max(lastSeqState[sessionId] ?? 0, pseq);
              readerLastSeq = Math.max(readerLastSeq, pseq);
              getModuleLive(sessionId).lastSeq = lastSeqState[sessionId];
            }
            // The Hermes API puts the event type in the SSE `event:` line; the
            // data payload does NOT carry an `event` field. Normalize so the
            // switch below matches on the real event type — without this every
            // frame fell through and the UI stayed stuck on "initializing".
            if (!(payload as any).event) {
              payload = { ...(payload as any), event } as StreamEvent;
            }
            sawRunEvent = true;

            switch (payload.event) {
              case "run.started": {
                const startedPayload = payload as Extract<StreamEvent, { event: "run.started" }>;
                runRuntime = startedPayload.runtime ?? null;
                const runId = String(startedPayload.run_id ?? "");
                if (runId && sessionId && !completionWatchRegistered) {
                  completionWatchRegistered = true;
                  watchRunCompletion({
                    runId,
                    sessionId,
                    url: "/chat",
                    title: "Hermes replied",
                  });
                }
                bumpLive({ phase: "initializing", stats: { ...(currentLive.stats ?? { toolCount: 0, failedTools: 0, startedAt }), runtime: runRuntime } });
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
                  if (activeIdRef.current === sessionId) setStreamedText(full);
                  if (sessionId) {
                    const snap = liveBySessionRef.current[sessionId];
                    if (snap) liveBySessionRef.current[sessionId] = { ...snap, streamedText: full };
                    // Module mirror — survives unmount (tab switch).
                    getModuleLive(sessionId).streamedText = full;
                  }
                  if (currentLive.phase !== "tools") bumpLive({ phase: "streaming" });
                  // Live token estimate so the footer's output-token count
                  // ticks up in real time instead of only appearing at the
                  // end. ~4 chars/token is a rough heuristic; the exact
                  // number is replaced by run.completed.usage when it lands.
                  const estOut = Math.max(1, Math.round(full.length / 4));
                  bumpLive({
                    stats: {
                      ...(currentLive.stats ?? { toolCount: 0, failedTools: 0, startedAt }),
                      toolCount,
                      failedTools: failedCount,
                      usage: {
                        ...(currentLive.stats?.usage ?? {}),
                        output_tokens: estOut,
                        total_tokens: (currentLive.stats?.usage?.input_tokens ?? 0) + estOut,
                      },
                    },
                  });
                }
                break;
              }
              case "reasoning.delta": {
                // Live thinking stream (per-delta reasoning from the model,
                // wired through the gateway's reasoning_callback 2026-08-29).
                const rdelta = (payload as any).delta ?? "";
                if (rdelta) {
                  reasoning += rdelta;
                  chain = appendReasoningToChain(chain, rdelta);
                  bumpLive({
                    reasoning,
                    chain,
                    phase: currentLive.phase === "initializing" ? "thinking" : currentLive.phase,
                  });
                }
                break;
              }
              case "tool.progress": {
                const tname = (payload as any).tool_name ?? "_thinking";
                const delta = (payload as any).delta ?? "";
                const isBeat = !!(payload as any).beat;
                dbg("sse", `tool.progress name=${tname} beat=${isBeat} delta=${delta.length}`, { sessionId, phase: currentLive.phase });
                if (tname === "_thinking") {
                  if (delta) {
                    reasoning += delta;
                    chain = appendReasoningToChain(chain, delta);
                    bumpLive({
                      reasoning,
                      chain,
                      phase: currentLive.phase === "initializing" ? "thinking" : currentLive.phase,
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
                      const updated = { ...exists, preview: beatPreview };
                      toolEvents = toolEvents.map((tool) => (tool === exists ? updated : tool));
                      // Keep tools[] and the ordered chain pointing at the same
                      // object, so repeated same-name calls update only this
                      // in-flight call and every later heartbeat still matches.
                      chain = chain.map((segment) =>
                        segment.kind === "tool" && segment.tool === exists
                          ? { ...segment, tool: updated }
                          : segment
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
                      stats: { ...(currentLive.stats ?? { toolCount: 0, failedTools: 0, startedAt }), toolCount, failedTools: failedCount },
                    });
                  }
                }
                break;
              }
              case "tool.started": {
                const tname = (payload as any).tool_name ?? "tool";
                dbg("sse", `tool.started name=${tname}`, { sessionId, phase: currentLive.phase });
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
                  const updated: ToolEvent = {
                    ...exists,
                    preview: (payload as any).preview ?? exists.preview,
                    args: (payload as any).args !== undefined ? JSON.stringify((payload as any).args).slice(0, 2000) : exists.args,
                  };
                  toolEvents = toolEvents.map((tool) => (tool === exists ? updated : tool));
                  chain = chain.map((segment) =>
                    segment.kind === "tool" && segment.tool === exists
                      ? { ...segment, tool: updated }
                      : segment
                  );
                  te = updated;
                }
                if (te && !chain.some((segment) => segment.kind === "tool" && segment.tool === te)) {
                  chain = [...chain, { kind: "tool", tool: te }];
                }
                bumpLive({
                  tools: toolEvents,
                  toolCount,
                  // Ensure the tool is in the ordered chain even if a
                  // tool.started raced ahead of tool.progress, and update the
                  // existing segment when started supplies richer args.
                  chain,
                  phase: "tools",
                  stats: { ...(currentLive.stats ?? { toolCount: 0, failedTools: 0, startedAt }), toolCount, failedTools: failedCount },
                });
                break;
              }
              case "tool.completed": {
                const tname = (payload as any).tool_name ?? "tool";
                const isErr = !!(payload as any).is_error;
                const durMs = (payload as any).duration !== undefined ? (payload as any).duration * 1000 : Date.now() - (toolEvents.find((t) => t.name === tname && (t.durationMs === undefined || t.interrupted))?.startedAt ?? Date.now());
                dbg("sse", `tool.completed name=${tname} err=${isErr} durMs=${Math.round(durMs)}`, { sessionId });
                toolEvents = completeFirstMatchingTool(toolEvents, tname, (tool) => ({
                  ...tool,
                  durationMs: durMs,
                  error: isErr,
                  interrupted: false,
                }));
                if (isErr) failedCount += 1;
                // Complete only the oldest matching in-flight call. Several
                // same-name tools may overlap; one completion frame must never
                // turn every matching chip into done.
                chain = completeFirstMatchingToolInChain(chain, tname, (tool) => ({
                  ...tool,
                  durationMs: durMs,
                  error: isErr,
                  interrupted: false,
                }));
                bumpLive({ tools: toolEvents, failedCount, chain, stats: { ...(currentLive.stats ?? { toolCount: 0, failedTools: 0, startedAt }), toolCount, failedTools: failedCount } });
                break;
              }
              case "tool.failed": {
                const tname = (payload as any).tool_name ?? "tool";
                dbg("sse", `tool.failed name=${tname}`, { sessionId });
                const failedAt = Date.now();
                toolEvents = completeFirstMatchingTool(toolEvents, tname, (tool) => ({
                  ...tool,
                  durationMs: failedAt - tool.startedAt,
                  error: true,
                  interrupted: false,
                }));
                failedCount += 1;
                chain = completeFirstMatchingToolInChain(chain, tname, (tool) => ({
                  ...tool,
                  durationMs: failedAt - tool.startedAt,
                  error: true,
                  interrupted: false,
                }));
                bumpLive({ tools: toolEvents, failedCount, chain, stats: { ...(currentLive.stats ?? { toolCount: 0, failedTools: 0, startedAt }), toolCount, failedTools: failedCount } });
                break;
              }
              case "assistant.completed": {
                const content = (payload as any).content;
                dbg("sse", `assistant.completed contentLen=${content?.length ?? 0} tools=${toolEvents.length}`, { sessionId, toolCount, failedCount });
                if (content) {
                  full = content;
                  if (sessionId) getModuleLive(sessionId).streamedText = content;
                  if (activeIdRef.current === sessionId) setStreamedText(content);
                  // 2026-09-02 FIX (silent fork rebind): when the session hit a
                  // compaction fork, the agent writes the reply into the FORK
                  // session, not the id this tab opened (X-Hermes-Session-Id /
                  // payload.session_id carry the effective id). Without this the
                  // reply persists server-side but never appears in the open
                  // chat ("messages not appearing"). Re-bind the view to the
                  // effective session and load its history.
                  {
                    const eff = (payload as any)?.session_id;
                    if (eff && sessionId && eff !== sessionId && activeIdRef.current === sessionId) {
                      dbg("sse", `fork rebind: ${sessionId} -> ${eff}`);
                      setActiveId(eff);
                      activeIdRef.current = eff;
                      setMessages([]);
                      loadMessages(String(eff), true, true);
                    }
                  }
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
                      : { kind: "tools" as const, calls: [{ name: c.tool.name, args: c.tool.args, result: undefined, error: c.tool.error, durationMs: c.tool.durationMs, interrupted: c.tool.interrupted }] }
                  );
                  finalToolCalls = toolEvents.map((t) => ({
                    name: t.name,
                    args: t.args,
                    result: undefined,
                    error: t.error,
                    durationMs: t.durationMs,
                    interrupted: t.interrupted,
                  }));
                  if (activeIdRef.current === sessionId) setMessages((m) => {
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
                  if (sessionId) moduleFinalAppended[sessionId] = true;
                }
                runRuntime = (payload as any).runtime ?? runRuntime;
                bumpLive({ phase: "streaming", stats: { ...(currentLive.stats ?? { toolCount: 0, failedTools: 0, startedAt }), runtime: runRuntime } });
                break;
              }
              case "run.completed": {
                runUsage = (payload as any).usage ?? null;
                runRuntime = (payload as any).runtime ?? runRuntime;
                completedCleanly = true;
                // Cache per-reply usage so history reloads re-apply it to the
                // final bubble (the DB doesn't persist per-message usage).
                if (sessionId && runUsage) {
                  moduleLastUsage[sessionId] = {
                    input_tokens: runUsage.input_tokens,
                    output_tokens: runUsage.output_tokens,
                    model: runRuntime?.model,
                  };
                }
                dbg("sse", `run.completed usage=${JSON.stringify(runUsage)?.slice(0, 120)}`, { sessionId, toolCount, failedCount, assistantAppended });
                const completedAt = Date.now();
                // Settle any tool still showing a spinner — a clean
                // run.completed means every tool finished; mark them done
                // so the UI never shows "loading forever" after a run.
                const nowMs = Date.now();
                toolEvents = toolEvents.map((t) => settleTool(t, nowMs));
                chain = chain.map((c) => settleToolInChain(c, nowMs));
                finalSegments = chain.map((c) =>
                  c.kind === "reasoning"
                    ? { kind: "reasoning" as const, text: c.text }
                    : { kind: "tools" as const, calls: [{ name: c.tool.name, args: c.tool.args, result: undefined, error: c.tool.error, durationMs: c.tool.durationMs, interrupted: c.tool.interrupted }] }
                );
                finalToolCalls = toolEvents.map((t) => ({
                  name: t.name,
                  args: t.args,
                  result: undefined,
                  error: t.error,
                  durationMs: t.durationMs,
                  interrupted: t.interrupted,
                }));
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
                if ((finalSegments.length > 0 || finalToolCalls.length > 0) && activeIdRef.current === sessionId) {
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
                // the old persistent footer bar). input/output are PER-REPLY
                // usage from this run — never the session lifetime sum.
                if (activeIdRef.current === sessionId) setMessages((prev) => {
                  const copy = [...prev];
                  for (let i = copy.length - 1; i >= 0; i--) {
                    if (copy[i].role === "assistant") {
                      copy[i] = {
                        ...copy[i],
                        stats: {
                          model: runRuntime?.model ?? MODEL,
                          tokens: runUsage?.total_tokens ?? runUsage?.input_tokens ?? undefined,
                          input_tokens: runUsage?.input_tokens,
                          output_tokens: runUsage?.output_tokens,
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
                terminalFailure = true;
                throw new Error((payload as any).error ?? (payload as any).message ?? "Stream error");
              }
            }
          }
        }
        } finally {
          clearInterval(stallTimer);
        }
      } catch (e: any) {
        const transportOnly = sawRunEvent && !terminalFailure;
        if (e?.name !== "AbortError" && !transportOnly) {
          terminalFailure = true;
          if (activeIdRef.current === sessionId) setError(e instanceof Error ? e.message : String(e));
          bumpLive({ phase: "error" });
        } else if (transportOnly || e?.name === "AbortError") {
          dbg("stream", "reader detached without terminal evidence — preserving run", {
            sessionId,
            reason: abort.signal.reason ?? e?.name,
          });
        }
      } finally {
        // A browser reader ending is not proof that the laptop agent ended.
        // Reconcile persisted history first, then settle only on an explicit
        // terminal frame, a final assistant message, or a user stop.
        const stillViewing = mountedRef.current && activeIdRef.current === sessionId;
        const readerSeqAtClose = readerLastSeq;
        const explicitlyStopped = abort.signal.reason === "user-stop";
        dbg("stream", `stream closed (finally) stillViewing=${stillViewing} completedCleanly=${completedCleanly} assistantAppended=${assistantAppended} stalled=${stalled}`, { sessionId, toolCount, failedCount, lastEventAgoMs: Date.now() - lastEventAt });

        let reconciled: ChatMsg[] = [];
        if (!completedCleanly || !assistantAppended) {
          try {
            dbg("stream", "safety-net loadMessages (tail dropped or answer missing)", { sessionId, completedCleanly, assistantAppended });
            if (sessionId) reconciled = await loadMessages(sessionId, false, false);
          } catch {
            /* best-effort */
          }
        }
        const lastPersisted = reconciled[reconciled.length - 1];
        const historyFinished =
          lastPersisted?.role === "assistant" &&
          lastPersisted.content.trim().length > 0 &&
          (reconciled.length > baselineMessageCount || lastPersisted.content !== baselineLastAssistant);
        const confirmedFinished =
          completedCleanly || assistantAppended || explicitlyStopped || terminalFailure || historyFinished;
        runFinished = confirmedFinished;

        if (sessionId) {
          const snapshot = getModuleLive(sessionId);
          const newerReaderAdvanced = snapshot.lastSeq > readerSeqAtClose;
          if (newerReaderAdvanced) {
            // A remounted page already replayed newer frames while this old
            // reader was awaiting reconciliation. Never overwrite that newer
            // module snapshot with the detached reader's stale accumulator.
            currentLive = snapshot.live;
            full = snapshot.streamedText;
          } else if (confirmedFinished) {
            snapshot.streamSession = null;
            currentLive = terminalFailure
              ? { ...settleLiveState(currentLive), phase: "error" }
              : settleLiveState(currentLive);
            snapshot.live = currentLive;
            snapshot.busy = false;
            snapshot.streamedText = full;
          } else {
            // Transport loss / page unmount / stall watchdog: preserve the
            // exact in-flight snapshot and let mount/focus/poll reattach from
            // the latest seq. Never fabricate done or clear partial text.
            snapshot.live = currentLive;
            snapshot.busy = true;
            snapshot.streamedText = full;
          }
          liveBySessionRef.current[sessionId] = {
            live: snapshot.live,
            streamedText: snapshot.streamedText,
          };
        }

        if (stillViewing) {
          if (confirmedFinished) {
            if (reconciled.length > 0) {
              messagesRef.current = reconciled;
              setMessages(reconciled);
            }
            setBusy(false);
            setStreamedText("");
            setLive(currentLive);
          } else {
            setBusy(true);
            setLive(currentLive);
            setStreamedText(full);
          }
        }
        if (streamSessionRef.current === sessionId) streamSessionRef.current = null;
        if (streamAbort.current === abort) {
          streamAbort.current = null;
          primaryStreamSessionRef.current = null;
        }
        if (stillViewing) await loadSessions();

        if (confirmedFinished && mountedRef.current) {
          // A queued turn must not launch merely because the viewer detached.
          busyRef.current = false;
          const queued = pendingQueue.current.splice(0);
          // 2026-09-01 FIX (queue loss): clear the localStorage mirror only
          // when the queue actually flushes.
          try {
            if (queued.length) window.localStorage.removeItem(`hermes-chat-queue-${sessionId ?? "new"}`);
          } catch {
            /* ignore */
          }
          for (const q of queued) {
            if (stillViewing) {
              setMessages((current) => current.filter((message) => !(message.role === "system" && message.content.includes("Queued — waiting"))));
            }
            await send(q);
          }
        }
      }

      if (runFinished && mountedRef.current && voiceOn && full) {
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
    [activeId, voiceOn, loadSessions, loadMessages, handleSlash, profile, attachments, effectiveModel, pinToLatest]
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
  // A component instance must not leave orphaned readers behind after SPA
  // navigation. Disconnecting these browser readers does not cancel Hermes'
  // server-side run; the next instance resumes from the persisted seq.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      streamAbort.current?.abort();
      reattachAbort.current?.abort();
    };
  }, []);
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
      // Don't double-attach to either the primary POST reader or an existing
      // tail reader. React's busy state can lag the ownership marker by a
      // render, so the marker alone is authoritative here.
      if (
        streamSessionRef.current === sessionId ||
        primaryStreamSessionRef.current === sessionId
      ) return;
      // Serialize concurrent reattaches: if one is already in flight for this
      // session, drop the duplicate. This also fixes the since=3/since=7 race
      // — the blocked caller never issues a second GET /events, so the cursor
      // can't be double-read.
      const inflight = reattachInflight.current;
      if (inflight.has(sessionId)) return;
      // No-op cooldown: skip reattach if we already found nothing <30s ago.
      if (Date.now() - (reattachNoopAt.current[sessionId] ?? 0) < 30_000) return;
      inflight.add(sessionId);
      // Switching conversations replaces the previous tail reader. Cancelling
      // this browser fetch only detaches the view; the laptop run keeps going.
      reattachAbort.current?.abort();
      const attachAbort = new AbortController();
      reattachAbort.current = attachAbort;
      const m = getModuleLive(sessionId);
      const baselineMessageCount = messagesRef.current.length;
      const baselineLastAssistant = [...messagesRef.current]
        .reverse()
        .find((message) => message.role === "assistant")?.content;
      // React state updaters may run after several replay frames have already
      // been parsed. Keep a synchronous module accumulator so a burst like
      // reasoning → tool → completion → final cannot read a stale prior frame.
      const commitReattachLive = (update: (current: LiveState) => LiveState): LiveState => {
        const next = update(m.live);
        m.live = next;
        liveBySessionRef.current[sessionId] = { live: next, streamedText: m.streamedText };
        if (activeIdRef.current === sessionId) setLive(next);
        return next;
      };
      try {
        const profileQs = profile ? `&profile=${encodeURIComponent(profile)}` : "";
        const res = await fetch(`/api/chat/sessions/${sessionId}/events?since=${lastSeqRef.current[sessionId] ?? m.lastSeq ?? 0}${profileQs}`, {
          cache: "no-store",
          signal: attachAbort.signal,
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
        m.streamSession = sessionId;
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
            if (typeof payload.seq === "number" && Number.isFinite(payload.seq)) {
              lastSeqRef.current[sessionId] = Math.max(
                lastSeqRef.current[sessionId] ?? 0,
                payload.seq
              );
              m.lastSeq = lastSeqRef.current[sessionId];
            }
            // First real event proves the run is live. A run.started frame (or
            // any live frame after an idle/terminal snapshot) begins a fresh
            // generation; never append a new run to the previous answer/chain.
            const terminalFrame = payload.event === "run.completed" || payload.event === "done" || payload.event === "error";
            if (!livePhase && !terminalFrame) {
              livePhase = true;
              dbg("reattach", `first frame event=${payload.event} seq=${payload.seq} — restoring live state`, { sessionId });
              m.busy = true;
              if (activeIdRef.current === sessionId) setBusy(true);
              const prev = liveBySessionRef.current[sessionId]?.live ?? m.live;
              const startsFresh =
                payload.event === "run.started" ||
                !prev ||
                prev.phase === "idle" ||
                prev.phase === "done" ||
                prev.phase === "error";
              if (startsFresh) {
                bumpRunGen(sessionId);
                m.streamedText = "";
                const resumed: LiveState = {
                  ...IDLE_LIVE,
                  phase: payload.event === "run.started" ? "initializing" : "thinking",
                  stats: {
                    toolCount: 0,
                    failedTools: 0,
                    startedAt: Date.now(),
                    runtime: payload.runtime ?? null,
                    usage: null,
                  },
                };
                commitReattachLive(() => resumed);
                if (activeIdRef.current === sessionId) setStreamedText("");
              } else if (activeIdRef.current === sessionId) {
                setLive(prev);
              }
            }
            if (payload.event === "run.started") {
              commitReattachLive((current) => ({
                ...current,
                phase: "initializing" as const,
                stats: {
                  ...(current.stats ?? { toolCount: 0, failedTools: 0, startedAt: Date.now() }),
                  runtime: payload.runtime ?? current.stats?.runtime ?? null,
                },
              }));
            } else if (payload.event === "message.started") {
              commitReattachLive((current) => ({ ...current, phase: "thinking" as const }));
            } else if (payload.event === "assistant.delta") {
              livePhase = true;
              const prevText = liveBySessionRef.current[sessionId]?.streamedText ?? m.streamedText ?? "";
              const text = prevText + (payload.delta ?? "");
              m.streamedText = text;
              commitReattachLive((p) => ({ ...p, phase: "streaming" as const }));
              if (activeIdRef.current === sessionId) setStreamedText(text);
            } else if (payload.event === "reasoning.delta") {
              // Live thinking frames on the reattach stream (gateway
              // reasoning_callback, 2026-08-29) — same accumulation as the
              // _thinking tool.progress path below.
              livePhase = true;
              const rdelta = (payload as any).delta ?? "";
              if (rdelta) {
                commitReattachLive((p) => ({
                  ...p,
                  reasoning: p.reasoning + rdelta,
                  chain: appendReasoningToChain(p.chain, rdelta),
                }));
              }
            } else if (payload.event === "tool.started" || payload.event === "tool.progress") {
              livePhase = true;
              const tname = payload.tool_name ?? "tool";
              // Reasoning deltas come through as _thinking tool.progress frames
              // — accumulate them into both `reasoning` and the ordered chain.
              if (tname === "_thinking") {
                const delta = payload.delta ?? "";
                if (delta) {
                  commitReattachLive((p) => ({
                    ...p,
                    reasoning: p.reasoning + delta,
                    chain: appendReasoningToChain(p.chain, delta),
                  }));
                }
                continue;
              }
              commitReattachLive((p) => {
                const tools = [...p.tools];
                const exists = tools.find((t) => t.name === tname && t.durationMs === undefined);
                let te: ToolEvent;
                if (!exists) {
                  te = {
                    name: tname,
                    startedAt: Date.now(),
                    preview: payload.preview ?? undefined,
                    args: payload.args !== undefined ? JSON.stringify(payload.args).slice(0, 2000) : undefined,
                  };
                  tools.push(te);
                } else {
                  te = exists;
                  if (payload.preview !== undefined || payload.args !== undefined) {
                    const updated = {
                      ...exists,
                      preview: payload.preview ?? exists.preview,
                      args: payload.args !== undefined ? JSON.stringify(payload.args).slice(0, 2000) : exists.args,
                    };
                    tools[tools.indexOf(exists)] = updated;
                    te = updated;
                  }
                }
                const chain = p.chain.map((c) =>
                  c.kind === "tool" && exists && c.tool === exists
                    ? { ...c, tool: te }
                    : c
                );
                const chainHas = chain.some((c) => c.kind === "tool" && c.tool === te);
                return {
                  ...p,
                  phase: "tools" as const,
                  tools,
                  toolCount: tools.length,
                  chain: chainHas ? chain : [...chain, { kind: "tool" as const, tool: te }],
                };
              });
            } else if (payload.event === "tool.completed" || payload.event === "tool.failed") {
              const tname = payload.tool_name ?? "tool";
              if (tname === "_thinking") continue;
              const isErr = payload.event === "tool.failed" || !!payload.is_error;
              commitReattachLive((p) => {
                const durationMs = (payload.duration ?? 0) * 1000;
                const tools = completeFirstMatchingTool(p.tools, tname, (tool) => ({
                  ...tool,
                  durationMs,
                  error: isErr,
                  interrupted: false,
                }));
                const chain = completeFirstMatchingToolInChain(p.chain, tname, (tool) => ({
                  ...tool,
                  durationMs,
                  error: isErr,
                  interrupted: false,
                }));
                return { ...p, tools, chain, failedCount: p.failedCount + (isErr ? 1 : 0) };
              });
            } else if (payload.event === "assistant.completed") {
              const content = payload.content ?? "";
              if (content) {
                if (activeIdRef.current === sessionId) setStreamedText(content);
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
                commitReattachLive((p) => ({ ...p, phase: "streaming", tools: settledTools, chain: settledChain }));
                if (activeIdRef.current === sessionId) setMessages((prev) => {
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
              commitReattachLive((p) => {
                // Settle any still-pending tools — the run is over.
                const now = Date.now();
                const tools = p.tools.map((t) => settleTool(t, now));
                const chain = p.chain.map((c) => settleToolInChain(c, now));
                return {
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
              });
              m.busy = false;
              m.streamSession = null;
              if (activeIdRef.current === sessionId) {
                setBusy(false);
              }
              if (streamSessionRef.current === sessionId) streamSessionRef.current = null;
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
              if ((finalSegs.length > 0 || finalTools.length > 0) && activeIdRef.current === sessionId) {
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
              if (payload.event === "error" && activeIdRef.current === sessionId) {
                // "no live run" is the normal reattach answer when nothing is
                // running (page reload, run already finished) — not an error
                // worth a red banner. Only surface real failures.
                const errMsg = String(payload.error ?? payload.message ?? "Stream error");
                if (!/no live run|404|not found/i.test(errMsg)) {
                  setError(errMsg);
                }
              }
              commitReattachLive((p) => ({
                ...settleLiveState(p),
                phase: payload.event === "error" ? "error" as const : "done" as const,
              }));
              if (activeIdRef.current === sessionId) setBusy(false);
              m.busy = false;
              m.streamSession = null;
              if (streamSessionRef.current === sessionId) streamSessionRef.current = null;
              livePhase = false;
            }
          }
        }
        // Stream closed. If the run was live, reconcile from the server so
        // nothing is lost; otherwise this was a finished/rotated run — either
        // way release the attach marker so future reattaches aren't blocked.
        dbg("reattach", `events stream closed livePhase=${livePhase}`, { sessionId });
        if (livePhase) {
          // A dropped tail is not itself completion evidence. Reconcile history;
          // only settle if the current turn has a persisted final assistant
          // answer (or assistant.completed was already observed). Otherwise
          // preserve busy/phase and let the session poll reattach again.
          const reconciled = await loadMessages(sessionId, false, false);
          const lastPersisted = reconciled[reconciled.length - 1];
          const finishedEvidence =
            moduleFinalAppended[sessionId] === true ||
            (lastPersisted?.role === "assistant" &&
              lastPersisted.content.trim().length > 0 &&
              (reconciled.length > baselineMessageCount || lastPersisted.content !== baselineLastAssistant));
          if (finishedEvidence) {
            m.busy = false;
            commitReattachLive((p) => settleLiveState(p));
            if (activeIdRef.current === sessionId) {
              if (reconciled.length > 0) {
                messagesRef.current = reconciled;
                setMessages(reconciled);
              }
              setBusy(false);
            }
          } else {
            m.busy = true;
            if (activeIdRef.current === sessionId) setBusy(true);
            dbg("reattach", "tail dropped without completion evidence — preserving live state", { sessionId });
          }
        } else {
          // Run finished (or rotated) before we reattached — no live frames
          // came back. The module snapshot may still hold un-settled
          // (spinning) tools from the interrupted stream: settle them now so
          // returning NEVER shows "loading forever". Also clear any stale
          // busy flag and reconcile the final answer from the server.
          if (activeIdRef.current === sessionId) setBusy(false);
          m.busy = false;
          // Remember this no-op so the 15s poll doesn't immediately re-fire
          // reattach for a run that already finished (hammer-loop fix).
          reattachNoopAt.current[sessionId] = Date.now();
          const now = Date.now();
          commitReattachLive((p) => {
            const stillPending = p.tools.some((t) => t.durationMs === undefined);
            if (!stillPending && p.phase === "done") return p;
            const tools = p.tools.map((t) => settleTool(t, now));
            const chain = p.chain.map((c) => settleToolInChain(c, now));
            return { ...p, tools, chain, phase: "done" as const };
          });
          // Reconcile the messages from the server so any final answer that
          // landed while we were away shows up.
          const reconciled = await loadMessages(sessionId, false, false).catch(() => [] as ChatMsg[]);
          if (activeIdRef.current === sessionId && reconciled.length > 0) {
            messagesRef.current = reconciled;
            setMessages(reconciled);
          }
        }
        if (streamSessionRef.current === sessionId) {
          streamSessionRef.current = null;
          m.streamSession = null;
        }
      } catch {
        // Aborted (new send started) or transient — the 15s session poll
        // will re-trigger reattach if the run is still live.
        dbg("reattach", `events stream ABORTED/ERROR`, { sessionId });
        if (activeIdRef.current === sessionId && !attachAbort.signal.aborted) {
          // A transport error is not evidence the laptop run ended. Preserve
          // the restored busy/phase snapshot until polling reconnects.
          setBusy(m.busy && m.live.phase !== "done" && m.live.phase !== "error");
        }
        if (!attachAbort.signal.aborted && streamSessionRef.current === sessionId) {
          streamSessionRef.current = null;
          m.streamSession = null;
        }
      } finally {
        if (reattachAbort.current === attachAbort) reattachAbort.current = null;
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
        if (sess?.is_active) reattachNoopAt.current[activeId] = 0;
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
      if ((sess?.is_active || snapActive) && streamSessionRef.current !== activeId) {
        if (sess?.is_active) reattachNoopAt.current[activeId] = 0;
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
    // Detach a tail reader for the conversation we're leaving. This never
    // interrupts the server-side agent; it only prevents the old reader from
    // mutating the newly selected conversation's UI.
    reattachAbort.current?.abort();
    // Save the current session's live state so we can restore it when the
    // user comes back — an active stream keeps its place in the UI.
    if (activeId) {
      liveBySessionRef.current[activeId] = { live, streamedText };
    }
    activeIdRef.current = id;
    setActiveId(id);
    messagesRef.current = [];
    setMessages([]);
    setStreamedText("");
    setLive(IDLE_LIVE);
    setInput(draftsRef.current[id] ?? "");
    // Restore this session's live state if it has one (background stream).
    const saved = liveBySessionRef.current[id];
    if (saved) {
      setLive(saved.live);
      setStreamedText(saved.streamedText);
    }
    const targetSnapshot = moduleLive[id];
    setBusy(
      !!targetSnapshot?.busy &&
      targetSnapshot.live.phase !== "idle" &&
      targetSnapshot.live.phase !== "done" &&
      targetSnapshot.live.phase !== "error"
    );
    // Await the load so the sidebar doesn't briefly show the wrong conversation.
    void loadMessages(id);
    // If the session we switched INTO is live — OR its module snapshot is
    // still un-settled (mid-flight or finished-without-settle) — reattach so
    // the run either continues or settles cleanly (never infinite spinners).
    const sess = sessions.find((s) => s.id === id);
    const snap = moduleLive[id];
    const snapActive = snap && snap.live.phase !== "idle" && snap.live.phase !== "done";
    if (sess?.is_active || snapActive || liveBySessionRef.current[id]) {
      if (sess?.is_active) reattachNoopAt.current[id] = 0;
      void reattachRun(id);
    }
    // On mobile the sidebar fills the whole view — close it after picking
    // so the conversation is visible. Desktop keeps it open.
    if (window.innerWidth < 768) setSidebarOpen(false);
  }, [activeId, loadMessages, live, streamedText, sessions, reattachRun, setActiveId]);

  const updateActiveDraft = useCallback((draft: string) => {
    if (activeId) draftsRef.current[activeId] = draft;
  }, [activeId]);

  const deleteSession = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await fetch(`/api/chat/sessions/${id}`, { method: "DELETE" });
      delete draftsRef.current[id];
      const list = await loadSessions();
      if (id === activeId) {
        if (list.length > 0) {
          activeIdRef.current = list[0].id;
          setActiveId(list[0].id);
          loadMessages(list[0].id);
        } else {
          activeIdRef.current = null;
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
          activeIdRef.current = list[0].id;
          setActiveId(list[0].id);
          loadMessages(list[0].id);
        } else {
          activeIdRef.current = null;
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
    const reasoningSegments = chainSegments.filter((segment) => segment.kind === "reasoning");

    return (
      <div className="flex justify-start">
        <div className="max-w-[88%] min-w-0 rounded-2xl border px-4 py-2.5 text-sm" style={{ borderColor: "var(--card-border)", background: "color-mix(in srgb, var(--bg) 60%, transparent)", color: "var(--text)" }}>
          {usingBrowser && <BrowserView />}
          {reasoningSegments.length > 0 && settings.reasoning !== "hidden" && (
            <div className="mb-2 space-y-2">
              {reasoningSegments.map((seg, i) => (
                  <div
                    key={`r-${i}`}
                    className="whitespace-pre-wrap rounded-lg border-l-2 px-2.5 py-1.5 text-xs leading-relaxed"
                    style={{ borderLeftColor: "var(--accent)", background: "rgba(124,108,255,0.06)", color: "var(--text-dim)" }}
                  >
                    {settings.reasoning === "partial" && seg.text.length > 900 ? seg.text.slice(-900) : seg.text}
                    {settings.reasoning === "partial" && seg.text.length > 900 && (
                      <div className="mt-1 text-[10px] italic opacity-60">(preview mode — showing tail)</div>
                    )}
                  </div>
              ))}
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
          {live.tools.length > 0 && (
            <div className="mt-2 space-y-1.5">
              <ToolCallStack tools={live.tools} mode={settings.tools} />
              <button
                onClick={() => setChainOpen(true)}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[10px] font-semibold"
                style={{ borderColor: "var(--card-border)", color: "var(--text-faint)" }}
              >
                <Maximize2 className="h-3 w-3" />
                View full chain ({live.tools.length} tool call{live.tools.length === 1 ? "" : "s"})
              </button>
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
                {(["chats", "bots"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => {
                      setViewTab(t);
                      if (t === "chats") {
                        setSessionFilter("chats");
                        setSessionsLoading(true);
                        loadSessions("chats");
                      }
                    }}
                    className="flex-1 rounded-lg px-2 py-1 text-[10px] font-semibold uppercase tracking-wide"
                    style={
                      viewTab === t
                        ? { background: "rgba(124,108,255,0.14)", color: "var(--accent)" }
                        : { color: "var(--text-faint)" }
                    }
                  >
                    {t === "chats" ? "Chats" : "Bots"}
                  </button>
                ))}
              </div>
              <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
                {viewTab === "chats" && (
                sessionsLoading ? (
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
                ))}
                {viewTab === "bots" && (
                  <div className="space-y-1">
                    <div className="mb-1 flex items-center justify-between px-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
                        My Bots
                      </span>
                      <button
                        onClick={() => {
                          setBotError(null);
                          setNewBotOpen((v) => !v);
                        }}
                        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold"
                        style={{ color: "var(--accent)", background: "rgba(124,108,255,0.10)" }}
                      >
                        <Plus className="h-3 w-3" /> New bot
                      </button>
                    </div>

                    {newBotOpen && (
                      <div className="mb-2 space-y-1.5 rounded-lg border p-2" style={{ borderColor: "var(--card-border)" }}>
                        <input
                          value={botForm.name}
                          onChange={(e) => setBotForm((f) => ({ ...f, name: e.target.value }))}
                          placeholder="bot name (e.g. coder)"
                          className="w-full rounded border bg-transparent px-2 py-1 text-xs outline-none"
                          style={{ borderColor: "var(--card-border)", color: "var(--text)" }}
                          aria-label="Bot name"
                        />
                        <input
                          value={botForm.description}
                          onChange={(e) => setBotForm((f) => ({ ...f, description: e.target.value }))}
                          placeholder="what is this bot for?"
                          className="w-full rounded border bg-transparent px-2 py-1 text-xs outline-none"
                          style={{ borderColor: "var(--card-border)", color: "var(--text)" }}
                          aria-label="Bot description"
                        />
                        <input
                          value={botForm.model}
                          onChange={(e) => setBotForm((f) => ({ ...f, model: e.target.value }))}
                          placeholder="model (e.g. deepseek-v4-flash:0731)"
                          className="w-full rounded border bg-transparent px-2 py-1 text-xs outline-none"
                          style={{ borderColor: "var(--card-border)", color: "var(--text)" }}
                          aria-label="Bot model"
                        />
                        {botError && (
                          <div className="text-[10px]" style={{ color: "var(--red)" }}>{botError}</div>
                        )}
                        <button
                          onClick={createBot}
                          disabled={botCreating || !botForm.name.trim()}
                          className="flex w-full items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                          style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
                        >
                          {botCreating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                          {botCreating ? "Creating…" : "Create bot"}
                        </button>
                      </div>
                    )}

                    {allProfiles.map((p) => {
                      const active = profile === p.id;
                      return (
                        <div
                          key={p.id || "default"}
                          role="button"
                          tabIndex={0}
                          onClick={() => openBot(p.id)}
                          onKeyDown={(e) => e.key === "Enter" && openBot(p.id)}
                          className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs"
                          style={
                            active
                              ? { background: "rgba(124,108,255,0.14)", color: "var(--text)" }
                              : { color: "var(--text-dim)" }
                          }
                        >
                          <span
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold uppercase"
                            style={{
                              background: active ? "var(--accent)" : "rgba(124,108,255,0.16)",
                              color: active ? "#fff" : "var(--accent-2)",
                            }}
                          >
                            {p.id ? p.id.charAt(0) : "H"}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-semibold">{p.label}</span>
                            <span className="block truncate text-[10px]" style={{ color: "var(--text-faint)" }}>
                              {p.model || p.role}
                            </span>
                          </span>
                          {active && (
                            <span className="shrink-0 text-[9px] font-bold uppercase" style={{ color: "var(--accent)" }}>
                              active
                            </span>
                          )}
                        </div>
                      );
                    })}
                    {allProfiles.length === 0 && (
                      <div className="px-2 py-4 text-xs" style={{ color: "var(--text-faint)" }}>
                        No bots yet — create one with New bot.
                      </div>
                    )}

                    {delegations.length > 0 && (
                      <div className="mt-2 border-t pt-2" style={{ borderColor: "var(--card-border)" }}>
                        <span className="px-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
                          Subagent activity
                        </span>
                        {delegations.map((d) => (
                          <div key={d.id} className="mt-1 rounded-lg border px-2 py-1.5" style={{ borderColor: "var(--card-border)" }}>
                            <div className="flex items-center gap-1.5">
                              {d.state === "completed" ? (
                                <CheckCircle2 className="h-3 w-3 shrink-0" style={{ color: "var(--green)" }} />
                              ) : d.state === "running" ? (
                                <Loader2 className="h-3 w-3 shrink-0 animate-spin" style={{ color: "var(--accent)" }} />
                              ) : (
                                <XCircle className="h-3 w-3 shrink-0" style={{ color: "var(--text-faint)" }} />
                              )}
                              <span className="truncate text-[10px] font-semibold uppercase" style={{ color: "var(--text-dim)" }}>
                                {(d.role || "subagent").toUpperCase()}
                              </span>
                              {d.model && (
                                <span className="truncate font-mono text-[9px]" style={{ color: "var(--text-faint)" }}>
                                  {d.model}
                                </span>
                              )}
                            </div>
                            <div className="mt-0.5 line-clamp-2 text-[10px] leading-relaxed" style={{ color: "var(--text-faint)" }}>
                              {d.goal || "(no goal recorded)"}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
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
                  activeIdRef.current = null;
                  setActiveId(null);
                  setSessionsLoading(true);
                  loadSessions(undefined, next).then((list) => {
                    if (list.length > 0) {
                      activeIdRef.current = list[0].id;
                      setActiveId(list[0].id);
                      loadMessages(list[0].id, true, true, next);
                    } else {
                      setMessagesLoading(false);
                    }
                  });
                }}
                className="rounded-lg border bg-transparent px-2 py-1 text-xs font-semibold outline-none"
                style={{ borderColor: "var(--card-border)", color: "var(--accent-2)" }}
                aria-label="Switch profile"
              >
                {allProfiles.map((p) => (
                  <option key={p.id || "default"} value={p.id}>
                    {p.label} — {p.role}
                  </option>
                ))}
              </select>
              {profile !== "" && (
                <span className="text-[10px]" style={{ color: "var(--text-faint)" }}>
                  {profileLabel(profile, extraProfiles)} profile — separate conversations, separate memory
                </span>
              )}
            </div>
            <div
              ref={messagesViewportRef}
              onScroll={updateFollowLatest}
              className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4"
            >
              <MessageHistory
                messages={messages}
                messagesLoading={messagesLoading}
                busy={busy}
                settings={settings}
              />
              {busy && <PhaseBanner phase={live.phase} toolCount={live.toolCount} elapsedSec={elapsedSec} sessionUsage={(() => { const u = live.stats?.usage ?? null; return u ? { input_tokens: u.input_tokens ?? 0 } : null; })()} />}
              {busy && renderLiveContent()}
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
              draftKey={activeId ?? "new"}
              setInput={setInput}
              onDraftChange={updateActiveDraft}
              send={send}
              busy={busy}
              stopRun={stopRun}
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
                  placeholder=""
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
