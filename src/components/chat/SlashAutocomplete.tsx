"use client";

// Slash command autocomplete — mirrors the native Hermes TUI/web UX.
// Full command surface from the Hermes registry, grouped by what the
// dashboard can actually do with each one.

export type SlashItem = {
  name: string;
  arg?: string;
  hint: string;
  group: "chat" | "session" | "system" | "info" | "tools";
};

export const SLASH_COMMANDS: SlashItem[] = [
  // Chat / session control
  { name: "new", hint: "Start a new conversation", group: "chat" },
  { name: "retry", hint: "Re-run the last message", group: "chat" },
  { name: "undo", arg: "[N]", hint: "Back up N turns and re-prompt", group: "chat" },
  { name: "title", arg: "<name>", hint: "Rename this conversation", group: "session" },
  { name: "fork", arg: "[name]", hint: "Branch this conversation", group: "session" },
  { name: "resume", arg: "[name]", hint: "Resume a named session", group: "session" },
  { name: "sessions", hint: "Browse and resume previous sessions", group: "session" },
  { name: "delete", arg: "<id>", hint: "Delete a session", group: "session" },
  { name: "compress", arg: "[here N]", hint: "Compress conversation context", group: "chat" },
  { name: "stop", hint: "Stop the current run", group: "chat" },
  { name: "background", arg: "<prompt>", hint: "Run a prompt in the background", group: "chat" },
  { name: "queue", arg: "<prompt>", hint: "Queue a prompt for the next turn", group: "chat" },
  { name: "steer", arg: "<prompt>", hint: "Inject a message after the next tool call", group: "chat" },
  { name: "goal", arg: "[text|status|clear]", hint: "Set a standing goal", group: "chat" },
  { name: "agents", hint: "Show active agents and running tasks", group: "info" },
  { name: "tasks", hint: "Show active agents and running tasks", group: "info" },

  // Model / runtime
  { name: "model", arg: "[name]", hint: "Switch model for this session", group: "system" },
  { name: "reasoning", arg: "[level]", hint: "Set reasoning effort", group: "system" },
  { name: "fast", arg: "[normal|fast]", hint: "Toggle fast mode", group: "system" },
  { name: "personality", arg: "[name]", hint: "Set a predefined personality", group: "system" },
  { name: "voice", arg: "[on|off|tts]", hint: "Toggle voice mode", group: "system" },
  { name: "yolo", hint: "Toggle approval bypass", group: "system" },
  { name: "approvals", arg: "[manual|smart|off]", hint: "Set approval mode", group: "system" },
  { name: "footer", arg: "[on|off]", hint: "Toggle runtime metadata footer", group: "system" },

  // Info
  { name: "context", hint: "Show context / token usage", group: "info" },
  { name: "status", hint: "Session, model and token status", group: "info" },
  { name: "usage", hint: "Token usage and rate limits", group: "info" },
  { name: "insights", arg: "[days]", hint: "Usage insights and analytics", group: "info" },
  { name: "version", hint: "Hermes Agent version", group: "info" },
  { name: "profile", hint: "Active profile", group: "info" },
  { name: "whoami", hint: "Your command access level", group: "info" },
  { name: "help", hint: "All Hermes commands", group: "info" },
  { name: "commands", arg: "[page]", hint: "Browse all commands", group: "info" },
  { name: "bundles", hint: "List skill bundles", group: "info" },
  { name: "skills", hint: "Search/install skills", group: "tools" },
  { name: "reload-skills", hint: "Re-scan skills directory", group: "tools" },
  { name: "reload-mcp", hint: "Reload MCP servers", group: "tools" },
  { name: "cron", hint: "Manage cron jobs", group: "tools" },
  { name: "kanban", arg: "[subcommand]", hint: "Multi-profile collaboration board", group: "tools" },
  { name: "curator", arg: "[subcommand]", hint: "Background skill maintenance", group: "tools" },
  { name: "learn", arg: "<what>", hint: "Learn a reusable skill", group: "tools" },
  { name: "init", arg: "[notes]", hint: "Generate AGENTS.md from repo scan", group: "tools" },
  { name: "diff", arg: "[staged|all]", hint: "Show git changes", group: "tools" },
  { name: "memory", arg: "[pending|approve|reject]", hint: "Review pending memory writes", group: "tools" },
  { name: "platform", arg: "[pause|resume|list]", hint: "Pause/resume gateway platforms", group: "system" },
  { name: "restart", hint: "Restart the gateway", group: "system" },
  { name: "update", hint: "Update Hermes Agent", group: "system" },
  { name: "topup", hint: "Show Nous balance / billing", group: "info" },
  { name: "debug", arg: "[nous|local]", hint: "Upload debug report", group: "info" },
];

export function SlashAutocomplete({
  input,
  onApply,
}: {
  input: string;
  onApply: (next: string) => void;
}) {
  if (!input.startsWith("/") || input.length < 1) return null;
  const query = input.slice(1).toLowerCase();
  const items = SLASH_COMMANDS.filter(
    (c) => c.name.startsWith(query) || query === ""
  ).slice(0, 12);
  if (items.length === 0) return null;

  return (
    <div
      className="absolute bottom-full left-0 right-0 z-40 mb-2 max-h-56 overflow-y-auto rounded-xl border shadow-xl"
      style={{ background: "var(--bg-2)", borderColor: "var(--card-border)" }}
    >
      {items.map((c) => (
        <button
          key={c.name}
          onClick={() => onApply(`/${c.name}${c.arg ? ` ${c.arg.replace(/[<>]/g, "")}` : ""} `)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/5"
          style={{ color: "var(--text)" }}
        >
          <span className="font-mono text-xs font-semibold" style={{ color: "var(--accent)" }}>
            /{c.name}
            {c.arg ? <span className="opacity-60"> {c.arg}</span> : ""}
          </span>
          <span className="ml-auto truncate text-xs" style={{ color: "var(--text-faint)" }}>
            {c.hint}
          </span>
        </button>
      ))}
    </div>
  );
}
