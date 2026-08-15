"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Send, Mic, MicOff, Volume2, MessageSquare, Plus, ChevronLeft, ChevronRight,
  Loader2, Trash2, Pencil, Square, Maximize2, Minimize2,
} from "lucide-react";
import type { ChatMsg, ChatSettings, SessionMeta, StreamEvent, ToolEvent, RunStats } from "@/lib/chat-types";
import { MessageBubble, MarkdownLite } from "@/components/chat/MessageBubble";
import { ChatSettingsButton, DEFAULT_SETTINGS, loadSettings } from "@/components/chat/ChatSettings";
import { SlashAutocomplete } from "@/components/chat/SlashAutocomplete";
import { PhaseBanner, RunStatsFooter, type RunPhase } from "@/components/chat/RunStatus";
import { MessageSkeleton, SessionListSkeleton } from "@/components/chat/Skeleton";
import { BrowserView } from "@/components/chat/BrowserView";

const MODEL = "deepseek-v4-flash:0731";

type LiveState = {
  phase: RunPhase;
  reasoning: string;
  tools: ToolEvent[];
  stats: RunStats | null;
  // tool call accounting for the current run
  toolCount: number;
  failedCount: number;
};

const IDLE_LIVE: LiveState = {
  phase: "idle",
  reasoning: "",
  tools: [],
  stats: null,
  toolCount: 0,
  failedCount: 0,
};

function toolEventToRunTool(t: ToolEvent) {
  return t;
}

export default function ChatPage() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sessionFilter, setSessionFilter] = useState<"chats" | "all">("chats");
  const [live, setLive] = useState<LiveState>(IDLE_LIVE);
  const [settings, setSettings] = useState<ChatSettings>(DEFAULT_SETTINGS);
  const [streamedText, setStreamedText] = useState("");
  const [elapsedSec, setElapsedSec] = useState(0);
  const [retryTarget, setRetryTarget] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const streamAbort = useRef<AbortController | null>(null);
  const liveRef = useRef(live);
  liveRef.current = live;
  // Synchronous busy flag — the `send` closure's `busy` goes stale during
  // the finally-block queue flush; this ref always has the latest value.
  const busyRef = useRef(false);
  busyRef.current = busy;
  // Per-conversation unsent draft text, preserved when navigating between chats.
  const draftsRef = useRef<Record<string, string>>({});
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [composerExpanded, setComposerExpanded] = useState(false);

  // Load display settings once.
  useEffect(() => {
    setSettings(loadSettings());
  }, []);

  // Auto-resize the composer textarea to fit its content (wraps after one
  // line, grows up to a cap). Collapses back to a single line when cleared.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input]);

  // Restore the unsent draft for the newly active conversation.
  useEffect(() => {
    if (activeId) setInput(draftsRef.current[activeId] ?? "");
  }, [activeId]);

  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/sessions", { cache: "no-store" });
      const data = await res.json();
      const list: SessionMeta[] = data?.data ?? data?.sessions ?? [];
      setSessions(list);
      return list;
    } catch (e) {
      setError(`Failed to load conversations: ${e instanceof Error ? e.message : e}`);
      return [];
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  const loadMessages = useCallback(async (id: string) => {
    setMessagesLoading(true);
    try {
      const res = await fetch(`/api/chat/sessions/${id}/messages`, { cache: "no-store" });
      const data = await res.json();
      const list = data?.data ?? [];
      const msgs: ChatMsg[] = list
        .filter((m: any) => ["user", "assistant", "system"].includes(m.role))
        .map((m: any) => ({
          role: m.role,
          content: m.content ?? "",
          reasoning: m.reasoning_content ?? m.reasoning ?? null,
        }));
      setMessages(msgs);
    } catch (e) {
      setError(`Failed to load messages: ${e instanceof Error ? e.message : e}`);
    } finally {
      setMessagesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSessions().then((list) => {
      if (list.length > 0) {
        setActiveId(list[0].id);
        loadMessages(list[0].id);
      } else {
        setMessagesLoading(false);
      }
    });
  }, [loadSessions, loadMessages]);

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

  const newConversation = useCallback(async () => {
    setBusy(true);
    setError(null);
    setLive(IDLE_LIVE);
    try {
      const res = await fetch("/api/chat/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      const id = data?.session?.id ?? data?.session_id ?? data?.data?.id;
      if (!id) throw new Error("No session id returned");
      if (activeId) draftsRef.current[activeId] = input;
      setActiveId(id);
      setMessages([]);
      setStreamedText("");
      await loadSessions();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
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
            setMessages((m) => [...m, { role: "system", content: "Usage: `/model <name>` — e.g. `/model deepseek-v4-flash:0731`. Model locks the session (runtime verified server-side)." }]);
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
            const inp = lastStats?.usage?.input_tokens ?? 0;
            const out = lastStats?.usage?.output_tokens ?? 0;
            const tot = lastStats?.usage?.total_tokens ?? 0;
            const out2 = [
              "**Context**",
              "",
              `Messages in session: ${sess?.message_count ?? messages.length}`,
              `Last run input tokens: ${inp.toLocaleString()}`,
              `Last run output tokens: ${out.toLocaleString()}`,
              `Last run total: ${tot.toLocaleString()}`,
              "Full per-run token data comes from the run stats footer on each reply.",
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
        case "background":
        case "queue":
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
      const trimmed = text.trim();
      if (!trimmed || !activeId) return;

      // Slash commands are handled locally (server-backed for info commands).
      if (trimmed.startsWith("/")) {
        const handled = await handleSlash(trimmed);
        if (handled) {
          if (activeId) draftsRef.current[activeId] = "";
          setInput("");
          return;
        }
      }

      // Never drop messages silently: if a run is active, queue the message
      // and surface it in the UI so the user knows it's waiting.
      if (busyRef.current) {
        pendingQueue.current.push(trimmed);
        setMessages((m) => [
          ...m,
          { role: "user", content: trimmed },
          { role: "system", content: "⏳ Queued — waiting for the current run to finish, then I'll pick this up." },
        ]);
        if (activeId) draftsRef.current[activeId] = "";
        setInput("");
        return;
      }

      if (activeId) draftsRef.current[activeId] = "";
      setInput("");
      setRetryTarget(trimmed);
      setMessages((m) => [...m, { role: "user", content: trimmed }]);
      setBusy(true);
      setError(null);
      setLive({
        phase: "initializing",
        reasoning: "",
        tools: [],
        stats: { toolCount: 0, failedTools: 0, startedAt: Date.now(), usage: null, runtime: null },
        toolCount: 0,
        failedCount: 0,
      });
      setStreamedText("");

      const abort = new AbortController();
      streamAbort.current = abort;

      let reasoning = "";
      let toolCount = 0;
      let failedCount = 0;
      let toolEvents: ToolEvent[] = [];
      let full = "";
      let runUsage: RunStats["usage"] = null;
      let runRuntime: RunStats["runtime"] = null;
      let startedAt = Date.now();

      const bumpLive = (patch: Partial<LiveState>) => {
        setLive((prev) => ({ ...prev, ...patch }));
      };

      try {
        const res = await fetch(`/api/chat/sessions/${activeId}/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: trimmed, model: MODEL }),
          signal: abort.signal,
        });
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => "");
          throw new Error(text || `Chat failed (${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        // Stall watchdog: if no SSE event lands for 90s, abort the fetch so
        // the finally block reconciles from the server and flushes the queue.
        // Prevents the "busy forever, messages silently dropped" failure.
        let lastEventAt = Date.now();
        const stallTimer = setInterval(() => {
          if (Date.now() - lastEventAt > 90_000) {
            abort.abort();
          }
        }, 15_000);

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

            switch (payload.event) {
              case "run.started": {
                runRuntime = (payload as any).runtime ?? null;
                bumpLive({ phase: "initializing", stats: { ...(liveRef.current.stats ?? { toolCount: 0, failedTools: 0, startedAt: Date.now() }), runtime: runRuntime } });
                // brief "initializing" beat then move to thinking as events flow
                break;
              }
              case "message.started": {
                bumpLive({ phase: "thinking" });
                break;
              }
              case "assistant.delta": {
                const delta = (payload as any).delta ?? "";
                if (delta) {
                  full += delta;
                  // Stream ONLY into the live bubble — do NOT append to the
                  // message list per-delta. Appending on every delta forces a
                  // full list re-render on mobile (shimmer/refresh feel).
                  setStreamedText(full);
                  if (liveRef.current.phase !== "tools") bumpLive({ phase: "streaming" });
                }
                break;
              }
              case "tool.progress": {
                const tname = (payload as any).tool_name ?? "_thinking";
                const delta = (payload as any).delta ?? "";
                if (tname === "_thinking") {
                  if (delta) {
                    reasoning += delta;
                    bumpLive({ reasoning, phase: liveRef.current.phase === "initializing" ? "thinking" : liveRef.current.phase });
                  }
                } else {
                  // Real tool activity: register the tool + phase.
                  const exists = toolEvents.find((t) => t.name === tname && t.durationMs === undefined);
                  if (!exists) {
                    toolEvents = [...toolEvents, { name: tname, startedAt: Date.now() }];
                    toolCount += 1;
                    bumpLive({ tools: toolEvents, toolCount, phase: "tools", stats: { ...(liveRef.current.stats ?? { toolCount: 0, failedTools: 0, startedAt: Date.now() }), toolCount, failedTools: failedCount } });
                  }
                }
                break;
              }
              case "tool.started": {
                const tname = (payload as any).tool_name ?? "tool";
                if (tname === "_thinking") break;
                const exists = toolEvents.find((t) => t.name === tname && t.durationMs === undefined);
                if (!exists) {
                  toolEvents = [...toolEvents, { name: tname, startedAt: Date.now(), preview: (payload as any).preview ?? undefined }];
                  toolCount += 1;
                } else {
                  toolEvents = toolEvents.map((t) => (t === exists ? { ...t, preview: (payload as any).preview ?? t.preview } : t));
                }
                bumpLive({ tools: toolEvents, toolCount, phase: "tools", stats: { ...(liveRef.current.stats ?? { toolCount: 0, failedTools: 0, startedAt: Date.now() }), toolCount, failedTools: failedCount } });
                break;
              }
              case "tool.completed": {
                const tname = (payload as any).tool_name ?? "tool";
                const isErr = !!(payload as any).is_error;
                const durMs = (payload as any).duration !== undefined ? (payload as any).duration * 1000 : Date.now() - (toolEvents.find((t) => t.name === tname)?.startedAt ?? Date.now());
                toolEvents = toolEvents.map((t) =>
                  t.name === tname && t.durationMs === undefined
                    ? { ...t, durationMs: durMs, error: isErr }
                    : t
                );
                if (isErr) failedCount += 1;
                bumpLive({ tools: toolEvents, failedCount, stats: { ...(liveRef.current.stats ?? { toolCount: 0, failedTools: 0, startedAt: Date.now() }), toolCount, failedTools: failedCount } });
                break;
              }
              case "tool.failed": {
                const tname = (payload as any).tool_name ?? "tool";
                toolEvents = toolEvents.map((t) =>
                  t.name === tname && t.durationMs === undefined
                    ? { ...t, durationMs: Date.now() - t.startedAt, error: true }
                    : t
                );
                failedCount += 1;
                bumpLive({ tools: toolEvents, failedCount, stats: { ...(liveRef.current.stats ?? { toolCount: 0, failedTools: 0, startedAt: Date.now() }), toolCount, failedTools: failedCount } });
                break;
              }
              case "assistant.completed": {
                const content = (payload as any).content;
                if (content) {
                  full = content;
                  setStreamedText(content);
                  setMessages((m) => {
                    const copy = [...m];
                    const last = copy[copy.length - 1];
                    if (last?.role === "assistant") {
                      copy[copy.length - 1] = { ...last, content, reasoning: reasoning || null };
                    } else {
                      copy.push({ role: "assistant", content, reasoning: reasoning || null });
                    }
                    return copy;
                  });
                }
                runRuntime = (payload as any).runtime ?? runRuntime;
                bumpLive({ phase: "streaming", stats: { ...(liveRef.current.stats ?? { toolCount: 0, failedTools: 0, startedAt: Date.now() }), runtime: runRuntime } });
                break;
              }
              case "run.completed": {
                runUsage = (payload as any).usage ?? null;
                runRuntime = (payload as any).runtime ?? runRuntime;
                const completedAt = Date.now();
                bumpLive({
                  phase: "done",
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
        setBusy(false);
        setStreamedText("");
        streamAbort.current = null;
        // Ensure the run settles to "done" even if the SSE tail (run.completed
        // with usage/runtime) was dropped through the proxy chain — the footer
        // should always appear with whatever stats we captured.
        setLive((prev) =>
          prev.phase === "error"
            ? prev
            : {
                ...prev,
                phase: "done",
                stats: {
                  ...(prev.stats ?? { toolCount: 0, failedTools: 0, startedAt: Date.now() }),
                  completedAt: Date.now(),
                  durationMs: Date.now() - (prev.stats?.startedAt ?? Date.now()),
                },
              }
        );
        // Reconcile against ground truth: the agent may have completed and
        // persisted the reply even if the tail of the SSE stream was dropped
        // (Vercel/ngrok timeouts). Reload from the server so nothing is lost.
        try {
          await loadMessages(activeId);
        } catch {
          /* best-effort */
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
          synth.speak(utter);
        } catch {
          /* TTS unavailable */
        }
      }
    },
    [busy, activeId, voiceOn, loadSessions, loadMessages, handleSlash]
  );

  sendRef.current = send;

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
    rec.interimResults = false;
    rec.onresult = (e: any) => {
      const text = e.results?.[0]?.[0]?.transcript ?? "";
      setInput(text);
      if (text.trim()) send(text);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
    rec.start();
    setListening(true);
    setError(null);
  }, [listening, send]);

  const selectSession = useCallback((id: string) => {
    if (busy) return;
    // Preserve the unsent draft of the conversation we're leaving.
    if (activeId) draftsRef.current[activeId] = input;
    setActiveId(id);
    setMessages([]);
    setStreamedText("");
    setLive(IDLE_LIVE);
    // Await the load so the sidebar doesn't briefly show the wrong conversation.
    void loadMessages(id);
    // On mobile the sidebar fills the whole view — close it after picking
    // so the conversation is visible. Desktop keeps it open.
    if (window.innerWidth < 768) setSidebarOpen(false);
  }, [busy, loadMessages, activeId, input]);

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

  const renderLiveContent = () => {
    if (live.phase === "idle") return null;
    const showReasoning =
      live.reasoning && settings.reasoning !== "hidden";
    const displayReasoning =
      settings.reasoning === "partial" && live.reasoning.length > 900
        ? live.reasoning.slice(-900)
        : live.reasoning;

    const usingBrowser = live.tools.some(
      (t) =>
        t.name.includes("browser") ||
        t.name.includes("web_extract") ||
        t.name.includes("web_search")
    );

    return (
      <div className="flex justify-start">
        <div className="max-w-[88%] min-w-0 rounded-2xl border px-4 py-2.5 text-sm" style={{ borderColor: "var(--card-border)", background: "color-mix(in srgb, var(--bg) 60%, transparent)", color: "var(--text)" }}>
          {usingBrowser && <BrowserView />}
          {showReasoning && (
            <div className="mb-2 whitespace-pre-wrap rounded-lg border-l-2 px-2.5 py-1.5 text-xs leading-relaxed" style={{ borderLeftColor: "var(--accent)", background: "rgba(124,108,255,0.06)", color: "var(--text-dim)", maxHeight: 240, overflowY: "auto" }}>
              {displayReasoning}
              {settings.reasoning === "partial" && live.reasoning.length > 900 && (
                <div className="mt-1 text-[10px] italic opacity-60">(preview mode — showing tail)</div>
              )}
            </div>
          )}
          {live.tools.length > 0 && settings.tools !== "count" && (
            <div className="mb-2 space-y-1">
              {live.tools.map((t, i) => (
                <div key={`${t.name}-${i}`} className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs" style={{ borderColor: "var(--card-border)", color: "var(--text-dim)" }}>
                  {t.durationMs !== undefined ? (
                    t.error ? <span style={{ color: "var(--red)" }}>✕</span> : <span style={{ color: "var(--green)" }}>✓</span>
                  ) : (
                    <Loader2 className="h-3 w-3 animate-spin" style={{ color: "var(--accent)" }} />
                  )}
                  <span className="truncate">{t.name.replace(/_/g, " ")}{t.preview ? ` — ${t.preview.slice(0, 80)}` : ""}</span>
                  {t.durationMs !== undefined && (
                    <span className="ml-auto font-mono text-[10px] opacity-70">{(t.durationMs / 1000).toFixed(1)}s</span>
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
          <ChatSettingsButton settings={settings} onChange={setSettings} />
          <button
            onClick={newConversation}
            disabled={busy}
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
          >
            <Plus className="h-4 w-4" /> New conversation
          </button>
        </div>
      </div>

      <div className="card relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1">
          {/* Conversation sidebar — slides in as a full-height overlay */}
          <div
            className={`${sidebarOpen ? "translate-x-0" : "-translate-x-full"} transition-transform duration-200 ease-out`}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              zIndex: 10,
              background: "color-mix(in srgb, var(--card-bg) 98%, transparent)",
              backdropFilter: "blur(2px)",
              borderRight: sidebarOpen ? "1px solid var(--card-border)" : "none",
            }}
          >
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-dim)" }}>
                  Conversations
                </span>
                <button
                  onClick={() => setSidebarOpen(false)}
                  className="rounded p-1"
                  style={{ color: "var(--text-faint)" }}
                  aria-label="Hide sidebar"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
              </div>
              <div className="flex gap-1 px-2 pb-1">
                {(["chats", "all"] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setSessionFilter(f)}
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
                      onClick={() => selectSession(s.id)}
                      onKeyDown={(e) => e.key === "Enter" && selectSession(s.id)}
                      className="group w-full cursor-pointer rounded-lg px-3 py-2 text-left text-xs"
                      style={
                        s.id === activeId
                          ? { background: "rgba(124,108,255,0.12)", color: "var(--text)" }
                          : { color: "var(--text-dim)" }
                      }
                    >
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
                          <div className="truncate font-medium">
                            {s.title || s.last_message || s.id.slice(0, 20)}
                          </div>
                          <div className="mt-0.5 flex items-center gap-2 text-[10px]" style={{ color: "var(--text-faint)" }}>
                            <span>{s.message_count ?? 0} msgs</span>
                            {s.tool_call_count != null && <span>· {s.tool_call_count} tools</span>}
                          </div>
                        </>
                      )}
                      {editingTitle !== s.id && (
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
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              {!sidebarOpen && (
                <button
                  onClick={() => setSidebarOpen(true)}
                  className="mb-2 flex items-center gap-1 rounded-lg border px-2 py-1 text-xs"
                  style={{ borderColor: "var(--card-border)", color: "var(--text-dim)" }}
                >
                  <ChevronRight className="h-3 w-3" /> Conversations
                </button>
              )}

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
                  {busy && (
                    <RunStatsFooter
                      stats={{
                        toolCount: live.toolCount,
                        failedTools: live.failedCount,
                        startedAt: live.stats?.startedAt ?? Date.now(),
                        completedAt: live.stats?.completedAt,
                        durationMs: live.stats?.durationMs,
                        usage: live.stats?.usage,
                        runtime: live.stats?.runtime,
                      }}
                      phase={live.phase}
                    />
                  )}
                  {!busy && live.phase === "done" && live.stats && settings.showStats && (
                    <RunStatsFooter stats={live.stats} phase="done" />
                  )}
                </>
              )}
              <div ref={bottomRef} />
            </div>

            {error && (
              <div className="border-t px-4 py-2 text-xs" style={{ borderColor: "var(--card-border)", color: "var(--red)" }}>
                {error}
              </div>
            )}

            {/* Composer — collapsed: auto-grows, wraps after one line */}
            <div className="relative flex items-end gap-2 border-t p-3" style={{ borderColor: "var(--card-border)" }}>
              <SlashAutocomplete
                input={input}
                onApply={(next) => setInput(next)}
              />
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
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  // Enter sends; Shift+Enter inserts a newline.
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send(input);
                  }
                }}
                rows={1}
                placeholder={activeId ? "Message Hermes…  (type / for commands)" : "Start a new conversation first…"}
                disabled={!activeId || busy}
                className="min-w-0 flex-1 resize-none overflow-y-auto rounded-lg border bg-transparent px-3 py-2 text-sm leading-relaxed outline-none disabled:opacity-50"
                style={{ borderColor: "var(--card-border)", color: "var(--text)", maxHeight: 120 }}
              />
              <button
                onClick={() => setComposerExpanded((v) => !v)}
                disabled={!activeId}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border disabled:opacity-40"
                style={{ borderColor: "var(--card-border)", color: "var(--text-dim)" }}
                aria-label={composerExpanded ? "Collapse composer" : "Expand composer"}
                title={composerExpanded ? "Collapse composer" : "Expand composer to fill the chat container"}
              >
                {composerExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </button>
              <button
                onClick={() => (busy ? stopRun() : send(input))}
                disabled={!busy && (!input.trim() || !activeId)}
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

            {/* Composer — expanded: fills the chat container (not the viewport) */}
            {composerExpanded && (
              <div
                className="absolute inset-0 z-20 flex flex-col"
                style={{ background: "var(--card)", borderColor: "var(--card-border)" }}
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
                  placeholder={activeId ? "Message Hermes…  (type / for commands)" : "Start a new conversation first…"}
                  disabled={!activeId || busy}
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
                    disabled={!busy && (!input.trim() || !activeId)}
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
