import { useRef, useState } from "react";
import type { ChainSegment, RunStats, ToolEvent } from "@/lib/chat-types";
import type { RunPhase } from "@/components/chat/RunStatus";

// LiveState mirror of the page's local type — identical shape. Defined here so
// this hook is fully self-contained and ready to be wired into the page in the
// NEXT extraction step (when send()/SSE stream logic moves out of the page).
// The page currently keeps its own LiveState / IDLE_LIVE; structurally these
// are compatible, so wiring the hook in later requires no type changes.
export type LiveState = {
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

export const IDLE_LIVE: LiveState = {
  phase: "idle",
  reasoning: "",
  tools: [],
  chain: [],
  stats: null,
  toolCount: 0,
  failedCount: 0,
};

export type SessionLiveSnapshot = {
  live: LiveState;
  streamedText: string;
};

// Per-session live-stream state. This hook is created as part of the chat
// god-file extraction roadmap but is NOT yet wired into the page — the page
// still holds its own stream state because send()/SSE logic (which reads and
// writes every field here) remains in the page for now. Wire this in only when
// that logic moves over, to avoid duplicating state.
export function useStreamState() {
  const [live, setLive] = useState<LiveState>(IDLE_LIVE);
  const [lastStats, setLastStats] = useState<RunStats | null>(null);
  const [streamedText, setStreamedText] = useState("");
  const [elapsedSec, setElapsedSec] = useState(0);
  // Which session the current SSE stream belongs to — so switching away
  // doesn't kill a background run, and switching back can restore its state.
  const streamSessionRef = useRef<string | null>(null);
  // Per-session live state, preserved across switches so an active stream
  // keeps rendering when you come back to its conversation.
  const liveBySessionRef = useRef<Record<string, SessionLiveSnapshot>>({});
  const streamAbort = useRef<AbortController | null>(null);

  return {
    live,
    setLive,
    lastStats,
    setLastStats,
    streamedText,
    setStreamedText,
    elapsedSec,
    setElapsedSec,
    streamSessionRef,
    liveBySessionRef,
    streamAbort,
  };
}
