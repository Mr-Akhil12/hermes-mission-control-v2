export const DEFAULT_MODEL = "deepseek-v4-flash:0731";

export const CONTEXT_WINDOWS: Record<string, number> = {
  "deepseek-v4-flash:0731": 1_000_000,
  "deepseek-v4-flash": 1_000_000,
  "deepseek-v3.2": 131_072,
  "gemini-2.5-flash": 1_048_576,
  "gemini-3.7-flash": 1_048_576,
  "minimax-m2.7": 204_800,
  "claude-sonnet-4": 1_000_000,
  "gpt-5.6-sol": 400_000,
};

export const CONTEXT_WINDOW_DEFAULT = 1_000_000;

export function contextWindowFor(model?: string | null): number {
  if (!model) return CONTEXT_WINDOW_DEFAULT;
  const key = model.toLowerCase();
  const direct = CONTEXT_WINDOWS[key];
  if (typeof direct === "number") return direct;
  for (const [name, w] of Object.entries(CONTEXT_WINDOWS)) {
    if (key.includes(name.toLowerCase())) return w;
  }
  return CONTEXT_WINDOW_DEFAULT;
}
