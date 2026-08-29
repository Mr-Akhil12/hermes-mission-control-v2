"use client";

// Slash command autocomplete — mirrors the native Hermes TUI/web UX.
// Full command surface from the Hermes registry, grouped by what the
// dashboard can actually do with each one.
//
// Discord-style structured entry: commands with known arguments get a
// step-by-step picker instead of free typing, so a broken/partial command
// can't be sent. /model walks provider → model, enum commands (/reasoning,
// /fast, /approvals, /voice, /yolo…) show option chips; free-text commands
// (/steer, /queue, /title…) show a hint row and only complete on real input.

import { useState, useEffect } from "react";
import { ChevronRight, Check, RefreshCw } from "lucide-react";

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
  { name: "model", arg: "<provider → model>", hint: "Switch model — guided picker", group: "system" },
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

// ── Structured argument pickers ──────────────────────────────────────
// Enum-style options for simple commands. Each inserts the full,
// ready-to-send command text.

const ARG_OPTIONS: Record<string, string[]> = {
  reasoning: ["off", "low", "medium", "high"],
  fast: ["normal", "fast"],
  voice: ["on", "off", "tts"],
  approvals: ["manual", "smart", "off"],
  footer: ["on", "off"],
  platform: ["pause", "resume", "list"],
  diff: ["staged", "all"],
  debug: ["nous", "local"],
  memory: ["pending", "approve", "reject"],
  insights: ["7", "30"],
};

// ── Dynamic model inventory (from Hermes /api/model/options) ─────────
// Shape comes from hermes_cli/inventory.py build_models_payload.

type InvModel = {
  model?: string;
  id?: string;
  name?: string;
};

type InvProvider = {
  slug?: string;
  name?: string;
  model?: string;      // current model on this provider
  models?: (string | InvModel)[];
  is_current?: boolean;
  configured?: boolean;
};

export type ModelInventory = {
  providers: InvProvider[];
  loadedAt: number | null;
  loading: boolean;
  error: string | null;
  reload: (refresh?: boolean) => void;
};

// Module-level hand-off from the /model wizard to the page's /model
// executor: which provider the user last picked. The wizard writes it here
// when a model row is chosen; the page's /model command handler reads it
// and sends `provider` alongside `model` so the gateway routes
// non-aliased (raw_request) models to the right provider.
export const lastModelPick: { providerSlug?: string; providerName?: string } = {};

export function useModelInventory(): ModelInventory {
  const [providers, setProviders] = useState<InvProvider[]>([]);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = (refresh = false) => {
    setLoading(true);
    setError(null);
    fetch(`/api/chat/models${refresh ? "?refresh=1" : ""}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        const provs: InvProvider[] = Array.isArray(data?.providers) ? data.providers : [];
        // Only providers that actually have models to pick from.
        setProviders(provs.filter((p) => (p.models?.length ?? 0) > 0));
        setLoadedAt(Date.now());
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  return { providers, loadedAt, loading, error, reload: load };
}

function modelId(m: string | InvModel): string {
  if (typeof m === "string") return m;
  return m.model ?? m.id ?? m.name ?? "";
}

type Panel =
  | { kind: "none" }
  | { kind: "options"; cmd: string; options: string[] }
  | { kind: "text-hint"; cmd: string; argHint: string }
  | { kind: "model-provider"; inv: ModelInventory };

function panelFor(input: string, inv: ModelInventory): Panel {
  // Bare or trailing-space "/cmd" → structured panel for that command.
  const m = input.match(/^\/([a-z-]+)(\s?)(.*)$/i);
  if (!m) return { kind: "none" };
  const [, cmdRaw, space, rest] = m;
  const cmd = SLASH_COMMANDS.find((c) => c.name === cmdRaw.toLowerCase());
  if (!cmd || !space || !cmd.arg) return { kind: "none" };
  // User already typed something after the command — stay out of the way,
  // except for /model where the wizard owns the whole flow.
  if (rest.trim().length > 0) return { kind: "none" };

  if (cmd.name === "model") return { kind: "model-provider", inv };
  if (ARG_OPTIONS[cmd.name]) return { kind: "options", cmd: cmd.name, options: ARG_OPTIONS[cmd.name] };
  return { kind: "text-hint", cmd: cmd.name, argHint: cmd.arg };
}

function Row({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/5"
      style={{ color: "var(--text)" }}
    >
      {children}
    </button>
  );
}

export function SlashAutocomplete({
  input,
  onApply,
}: {
  input: string;
  onApply: (next: string) => void;
}) {
  // Wizard position within the /model flow survives while the panel stays
  // mounted (input still starts with "/model "). Reset when leaving /model.
  const [modelStep, setModelStep] = useState<number | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<InvProvider | null>(null);
  const inv = useModelInventory();
  // Fetch inventory when the /model wizard first opens.
  useEffect(() => {
    if (/^\/model\s?$/.test(input) && inv.providers.length === 0 && !inv.loading && inv.loadedAt === null) {
      inv.reload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input]);

  const startsModel = /^\/model\s?$/.test(input);

  if (!input.startsWith("/") || input.length < 1) return null;

  // ── Command-name phase: filter the registry as the user types ──
  const bareQuery = input.slice(1).toLowerCase();
  const structured = panelFor(input, inv);

  if (structured.kind === "none" && !bareQuery.includes(" ")) {
    const items = SLASH_COMMANDS.filter(
      (c) => c.name.startsWith(bareQuery) || bareQuery === ""
    ).slice(0, 12);
    if (items.length === 0) return null;
    return (
      <div
        className="absolute bottom-full left-0 right-0 z-40 mb-2 max-h-56 overflow-y-auto rounded-xl border shadow-xl"
        style={{ background: "var(--bg-2)", borderColor: "var(--card-border)" }}
      >
        {items.map((c) => (
          <Row key={c.name} onClick={() => onApply(`/${c.name}${c.arg ? " " : ""}`)}>
            <span className="font-mono text-xs font-semibold" style={{ color: "var(--accent)" }}>
              /{c.name}
              {c.arg ? <span className="opacity-60"> {c.arg}</span> : ""}
            </span>
            <span className="ml-auto truncate text-xs" style={{ color: "var(--text-faint)" }}>
              {c.hint}
            </span>
          </Row>
        ))}
        <div className="px-3 py-1.5 text-[10px]" style={{ color: "var(--text-faint)", borderTop: "1px solid var(--card-border)" }}>
          Commands with arguments open a guided picker — press Enter to send once filled.
        </div>
      </div>
    );
  }

  if (structured.kind === "none") return null;

  const shell = (children: React.ReactNode, title?: string) => (
    <div
      className="absolute bottom-full left-0 right-0 z-40 mb-2 max-h-56 overflow-y-auto rounded-xl border shadow-xl"
      style={{ background: "var(--bg-2)", borderColor: "var(--card-border)" }}
    >
      {title && (
        <div
          className="flex items-center gap-1 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide"
          style={{ color: "var(--text-faint)", borderBottom: "1px solid var(--card-border)" }}
        >
          {title}
        </div>
      )}
      {children}
    </div>
  );

  // ── /model wizard ──
  if (structured.kind === "model-provider") {
    if (!startsModel && modelStep !== null) {
      setModelStep(null);
      setSelectedProvider(null);
    }
    const step = startsModel ? modelStep : null;

    // Step 2: models for the selected provider
    if (step !== null && selectedProvider) {
      const models = (selectedProvider.models ?? []).map(modelId).filter(Boolean);
      return shell(
        <>
          <Row
            onClick={() => {
              setModelStep(null);
              setSelectedProvider(null);
              onApply("/model ");
            }}
          >
            <span className="text-xs" style={{ color: "var(--text-faint)" }}>← Back to providers</span>
          </Row>
          {models.map((mName) => (
            <Row key={mName} onClick={() => {
              lastModelPick.providerSlug = selectedProvider.slug;
              lastModelPick.providerName = selectedProvider.name ?? selectedProvider.slug;
              onApply(`/model ${mName}`);
            }}>
              <Check className="h-3.5 w-3.5 shrink-0 opacity-0" />
              <span className="font-mono text-xs">{mName}</span>
              <span className="ml-auto text-[10px]" style={{ color: "var(--text-faint)" }}>
                {selectedProvider.name ?? selectedProvider.slug}
                {selectedProvider.model === mName ? " · current" : ""}
              </span>
            </Row>
          ))}
        </>,
        `/model — ${selectedProvider.name ?? selectedProvider.slug}`
      );
    }

    // Step 1: provider list from live inventory
    const providers = inv.providers;
    return shell(
      <>
        {providers.length > 0 && (
          <Row
            onClick={() => inv.reload(true)}
          >
            <RefreshCw className={`h-3.5 w-3.5 shrink-0 ${inv.loading ? "animate-spin" : ""}`} style={{ color: "var(--text-faint)" }} />
            <span className="text-xs" style={{ color: "var(--text-faint)" }}>
              {inv.loading ? "Refreshing live catalogs…" : "Refresh live provider catalogs"}
            </span>
          </Row>
        )}
        {inv.loading && providers.length === 0 && (
          <div className="px-3 py-3 text-xs" style={{ color: "var(--text-faint)" }}>
            Loading providers…
          </div>
        )}
        {inv.error && (
          <div className="px-3 py-3 text-xs" style={{ color: "var(--text-faint)" }}>
            Could not load model inventory — {inv.error.slice(0, 80)}
          </div>
        )}
        {!inv.loading && !inv.error && providers.length === 0 && (
          <div className="px-3 py-3 text-xs" style={{ color: "var(--text-faint)" }}>
            No configured providers found — add a key in Hermes config first.
          </div>
        )}
        {providers.map((p) => (
          <Row
            key={p.slug ?? p.name}
            onClick={() => {
              setSelectedProvider(p);
              setModelStep(1);
              onApply("/model ");
            }}
          >
            <span className="font-semibold" style={{ color: "var(--accent)" }}>
              {p.name ?? p.slug}
            </span>
            {p.is_current && (
              <span className="rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase" style={{ background: "var(--accent)", color: "var(--bg)" }}>
                active
              </span>
            )}
            <span className="ml-auto truncate text-xs" style={{ color: "var(--text-faint)" }}>
              {p.models?.length ?? 0} models
            </span>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-50" />
          </Row>
        ))}
      </>,
      "/model — live provider inventory"
    );
  }

  // ── Enum options ──
  if (structured.kind === "options") {
    return shell(
      structured.options.map((opt) => (
        <Row key={opt} onClick={() => onApply(`/${structured.cmd} ${opt}`)}>
          <span className="font-mono text-xs font-semibold" style={{ color: "var(--accent)" }}>
            /{structured.cmd} {opt}
          </span>
        </Row>
      )),
      `/${structured.cmd} — pick an option`
    );
  }

  // ── Free-text commands: nudge, don't block ──
  return shell(
    <div className="px-3 py-2 text-xs" style={{ color: "var(--text-dim)" }}>
      <span className="font-mono font-semibold" style={{ color: "var(--accent)" }}>/{structured.cmd}</span>{" "}
      <span className="opacity-70">{structured.argHint}</span> — type your text after the command, then Enter to send.
    </div>,
    `/${structured.cmd}`
  );
}