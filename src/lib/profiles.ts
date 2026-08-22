// Chat profile routing — the "who am I talking to" switcher.
// Each entry maps to a Hermes multiplex profile (gateway.multiplex_profiles)
// reached via /p/<profile>/… mirrors on the API server.

export type ChatProfile = {
  id: string; // empty string = default profile
  label: string;
  role: string;
  model?: string; // the profile's configured model (from config.yaml model.default)
};

// Static fallback list — used until the live /api/chat/profiles fetch
// resolves, and merged with any profiles found on the machine so a profile
// created via `hermes profile create` appears automatically.
export const PROFILES: ChatProfile[] = [
  { id: "", label: "Hermes", role: "Default — orchestration, general work" },
  { id: "coder", label: "Coder", role: "Code, bugs, features" },
  { id: "coder-pro", label: "Coder Pro", role: "Architecture, security, complex code" },
  { id: "critic", label: "Critic", role: "Code review, second opinions" },
  { id: "breaker", label: "Breaker", role: "Edge cases, try to break things" },
  { id: "verifier", label: "Verifier", role: "Fact-checking, confirm claims" },
  { id: "researcher", label: "Researcher", role: "Deep research, citations" },
  { id: "ops", label: "Ops", role: "Cron, deployments, infrastructure" },
];

export function profileById(id: string, extra: ChatProfile[] = []): ChatProfile {
  return [...extra, ...PROFILES].find((p) => p.id === id) ?? PROFILES[0];
}

export function profileLabel(id: string, extra: ChatProfile[] = []): string {
  return profileById(id, extra).label;
}

/** Prepend the /p/<profile>/ prefix for upstream Hermes API calls. */
export function withProfile(path: string, profile: string): string {
  return profile ? `/p/${profile}${path}` : path;
}
