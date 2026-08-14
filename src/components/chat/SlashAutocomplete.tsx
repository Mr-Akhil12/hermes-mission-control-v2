"use client";

// Slash command autocomplete — mirrors the native Hermes TUI/web UX.
// Curated list of commands that actually work through the dashboard's HTTP
// surface (API endpoints) plus informational ones the state server executes.

export type SlashItem = {
  name: string;
  arg?: string;
  hint: string;
  group: "chat" | "session" | "system" | "info";
};

export const SLASH_COMMANDS: SlashItem[] = [
  { name: "new", hint: "Start a new conversation", group: "chat" },
  { name: "retry", hint: "Re-run the last message", group: "chat" },
  { name: "title", arg: "<name>", hint: "Rename this conversation", group: "session" },
  { name: "fork", arg: "[name]", hint: "Branch this conversation", group: "session" },
  { name: "context", hint: "Show context / token usage", group: "info" },
  { name: "status", hint: "Session, model and token status", group: "info" },
  { name: "version", hint: "Hermes Agent version", group: "info" },
  { name: "profile", hint: "Active profile", group: "info" },
  { name: "whoami", hint: "Your command access level", group: "info" },
  { name: "help", hint: "All Hermes commands", group: "info" },
  { name: "model", arg: "[name]", hint: "Switch model for this session", group: "system" },
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
  );
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
