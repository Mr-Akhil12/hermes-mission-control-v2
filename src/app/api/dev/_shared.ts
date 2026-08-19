// Shared helpers for the /api/dev/* routes.
// All Vercel + GitHub calls happen server-side here — tokens never reach the client.

const GH_OWNER = "Mr-Akhil12";
const GH_TOKEN = process.env.GITHUB_TOKEN ?? "";
const VERCEL_TOKEN = process.env.VERCEL_TOKEN ?? "";

const EXTERNAL_TIMEOUT = 10000;

// ── GitHub response shapes ───────────────────────────────────────────────

export interface GhRepo {
  name: string;
  private: boolean;
  description: string | null;
  default_branch: string;
  pushed_at: string;
  html_url: string;
  size: number;
  language: string | null;
  open_issues_count: number;
  stargazers_count: number;
}

export interface GhCommit {
  sha: string;
  commit: { message: string; author: { date: string; name: string } };
  author: { login: string } | null;
}

export interface GhDeployment {
  id: number;
  ref: string;
  environment: string;
  created_at: string;
}

export interface GhTreeEntry {
  path: string;
  type: string;
  size?: number;
}

export interface GhTree {
  tree: GhTreeEntry[];
  truncated: boolean;
}

// ── Vercel response shapes ──────────────────────────────────────────────

export interface VercelProject {
  id: string;
  name: string;
  framework: string | null;
  link: { type: string; repo: string; org: string; productionBranch: string } | null;
  updatedAt: string;
}

export interface VercelProjects {
  projects: VercelProject[];
}

export interface VercelDeployment {
  uid: string;
  name: string;
  url: string;
  readyState: string;
  created: number;
  target: string;
}

export interface VercelDeployments {
  deployments: VercelDeployment[];
}

// ── Fetch helpers ──────────────────────────────────────────────────────

/** GitHub API fetch with auth + timeout. Returns parsed JSON or throws. */
export async function ghFetch<T>(path: string): Promise<T> {
  if (!GH_TOKEN) throw new Error("GITHUB_TOKEN not configured");
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "hermes-mission-control",
    },
    signal: AbortSignal.timeout(EXTERNAL_TIMEOUT),
    cache: "no-store",
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`github ${res.status} ${msg.slice(0, 120)}`);
  }
  return res.json() as Promise<T>;
}

/** Vercel API fetch with auth + timeout. Returns parsed JSON or throws. */
export async function vercelFetch<T>(path: string): Promise<T> {
  if (!VERCEL_TOKEN) throw new Error("VERCEL_TOKEN not configured");
  const res = await fetch(`https://api.vercel.com${path}`, {
    headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
    signal: AbortSignal.timeout(EXTERNAL_TIMEOUT),
    cache: "no-store",
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`vercel ${res.status} ${msg.slice(0, 120)}`);
  }
  return res.json() as Promise<T>;
}

export const GH_OWNER_CONST = GH_OWNER;

/** Directories that should never appear in a project file tree. */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "build",
  ".venv",
  "venv",
  "__pycache__",
  ".turbo",
  ".vercel",
  ".cache",
  "coverage",
  ".output",
  ".nuxt",
  ".svelte-kit",
]);

/** Filter a raw git-trees listing down to the paths we want to show. */
export function filterTree(
  tree: GhTreeEntry[]
): { path: string; type: string; size: number }[] {
  return tree
    .filter((entry) => {
      const parts = entry.path.split("/");
      return !parts.some((p) => IGNORED_DIRS.has(p));
    })
    .map((entry) => ({
      path: entry.path,
      type: entry.type === "tree" ? "dir" : "file",
      size: typeof entry.size === "number" ? entry.size : 0,
    }));
}

/** Title Case a repo/project name for display. */
export function titleCase(name: string): string {
  return name
    .split(/[-_]/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}
