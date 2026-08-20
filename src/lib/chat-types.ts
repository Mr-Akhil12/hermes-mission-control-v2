// Shared chat types — mirror the Hermes API SSE event contract
// (gateway/platforms/api_server.py _handle_session_chat_stream).

export type ChatMsg = {
  role: "user" | "assistant" | "system";
  content: string;
  reasoning?: string | null;
  // Tool calls made by the assistant before producing this content —
  // reconstructed from the persisted message store so history shows the
  // full chain (reasoning → tool → reasoning → tool → answer), not just
  // the final text.
  toolCalls?: ToolCallInfo[];
  // Per-message stats (model + token count) shown at the end of the bubble.
  // Populated from the persisted row's token_count + session model, and
  // from the live run's completed usage. Replaces the persistent footer bar.
  stats?: { model?: string; tokens?: number } | null;
  // ORDERED turn segments for history: reasoning blocks and tool calls
  // interleaved exactly as they happened (same structure as the live chain),
  // so returning to a finished conversation renders like the live stream —
  // reasoning → tool → reasoning → tool → answer — never a flattened blob.
  segments?: ChatSegment[];
};

// One ordered segment of a persisted assistant turn — mirrors ChainSegment
// but carries ToolCallInfo (with results) instead of live ToolEvent.
export type ChatSegment =
  | { kind: "reasoning"; text: string }
  | { kind: "tools"; calls: ToolCallInfo[] };

export type ToolCallInfo = {
  id?: string;
  name: string;
  args?: string;
  result?: string;
  error?: boolean;
  durationMs?: number;
  // History reconstruction sets this when the persisted transcript has NO
  // tool-result row for this call (cancelled/interrupted runs, dropped
  // persistence). The chip renders a muted "interrupted" state instead of a
  // spinner or a fabricated success.
  interrupted?: boolean;
};

export type ToolEvent = {
  name: string;
  startedAt: number;
  durationMs?: number;
  error?: boolean;
  preview?: string;
  args?: string;
  // True when the run ended without this tool ever receiving a completion
  // frame (dropped through the proxy). Renders a muted "interrupted" state —
  // never a fabricated success or an eternal spinner.
  interrupted?: boolean;
};

// Ordered chain segment for the LIVE view — reasoning and tool calls are
// rendered in the exact order they happened (reasoning → tool → reasoning →
// tool → answer), never split into separate disappearing sections.
export type ChainSegment =
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; tool: ToolEvent };

export type RunUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
};

export type RunRuntime = {
  provider?: string;
  model?: string;
  route_source?: string;
  requested?: { provider?: string; model?: string };
};

export type RunStats = {
  usage?: RunUsage | null;
  runtime?: RunRuntime | null;
  toolCount: number;
  failedTools: number;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
};

// Event payloads arriving on the /api/chat/sessions/[id]/stream SSE.
export type StreamEvent =
  | { event: "run.started"; run_id?: string; runtime?: RunRuntime }
  | { event: "message.started"; message?: { id?: string } }
  | { event: "assistant.delta"; delta?: string }
  | {
      event: "tool.progress";
      tool_name?: string;
      delta?: string;
      preview?: string;
    }
  | {
      event: "tool.started" | "tool.completed" | "tool.failed";
      tool_name?: string;
      preview?: string;
      args?: unknown;
      duration?: number;
      is_error?: boolean;
    }
  | {
      event: "assistant.completed";
      content?: string;
      completed?: boolean;
      interrupted?: boolean;
      runtime?: RunRuntime;
    }
  | {
      event: "run.completed";
      usage?: RunUsage;
      runtime?: RunRuntime;
      messages?: unknown[];
    }
  | { event: "done" }
  | { event: "error"; error?: string; message?: string };

export type SessionMeta = {
  id: string;
  title?: string | null;
  message_count?: number;
  last_message?: string | null;
  tool_call_count?: number;
  source?: string;
  created_at?: string;
  updated_at?: string;
  started_at?: string | number;
  ended_at?: string | number | null;
  is_active?: boolean;
  // REAL cumulative usage for the whole session (maintained by Hermes on
  // every API call) — the actual context that has been sent to the model,
  // not the last run's usage.
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  api_call_count?: number;
};

// Display settings persisted to localStorage.
export type ChatSettings = {
  reasoning: "full" | "partial" | "hidden";
  tools: "technical" | "summary" | "count";
  showStats: boolean;
  autoScroll: boolean;
};
