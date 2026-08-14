// Shared chat types — mirror the Hermes API SSE event contract
// (gateway/platforms/api_server.py _handle_session_chat_stream).

export type ChatMsg = {
  role: "user" | "assistant" | "system";
  content: string;
  reasoning?: string | null;
};

export type ToolEvent = {
  name: string;
  startedAt: number;
  durationMs?: number;
  error?: boolean;
  preview?: string;
};

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
  created_at?: string;
  updated_at?: string;
};

// Display settings persisted to localStorage.
export type ChatSettings = {
  reasoning: "full" | "partial" | "hidden";
  tools: "technical" | "summary" | "count";
  showStats: boolean;
  autoScroll: boolean;
};
