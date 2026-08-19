import { NextResponse } from "next/server";
import {
  ghFetch,
  vercelFetch,
  type GhRepo,
  type VercelProject,
} from "../_shared";

// GET /api/dev/projects — merged Vercel + GitHub project list.
// Graceful on partial failure: never 500s if one provider is down.

export async function GET() {
  const warnings: string[] = [];
  let vercelProjects: VercelProject[] = [];
  let githubRepos: GhRepo[] = [];

  const [vercelRes, githubRes] = await Promise.allSettled([
    vercelFetch<{ projects: VercelProject[] }>("/v6/projects?limit=100"),
    ghFetch<GhRepo[]>("/user/repos?per_page=100&sort=updated"),
  ]);

  if (vercelRes.status === "fulfilled") {
    vercelProjects = vercelRes.value?.projects ?? [];
  } else {
    warnings.push(`Vercel unavailable: ${vercelRes.reason?.message ?? "unknown"}`);
  }

  if (githubRes.status === "fulfilled") {
    githubRepos = githubRes.value ?? [];
  } else {
    warnings.push(`GitHub unavailable: ${githubRes.reason?.message ?? "unknown"}`);
  }

  // Build a lookup of GitHub repos by name.
  const ghByName = new Map<string, GhRepo>();
  for (const repo of githubRepos) {
    ghByName.set(repo.name, repo);
  }

  // Merge: match Vercel projects to GitHub repos by name (or link.repo).
  const merged = new Map<string, Record<string, unknown>>();

  for (const vp of vercelProjects) {
    const linkRepo = vp.link?.repo ?? null;
    const name = linkRepo || vp.name;
    const gh = ghByName.get(name);
    merged.set(name, {
      name,
      source: gh ? "both" : "vercel",
      vercelId: vp.id ?? null,
      framework: vp.framework ?? null,
      repo: gh ? `Mr-Akhil12/${name}` : null,
      private: gh?.private ?? null,
      description: gh?.description ?? null,
      defaultBranch: gh?.default_branch ?? vp.link?.productionBranch ?? null,
      pushedAt: gh?.pushed_at ?? null,
      updatedAt: vp.updatedAt ?? null,
      url: gh?.html_url ?? null,
    });
  }

  for (const repo of githubRepos) {
    if (merged.has(repo.name)) continue;
    merged.set(repo.name, {
      name: repo.name,
      source: "github",
      vercelId: null,
      framework: null,
      repo: `Mr-Akhil12/${repo.name}`,
      private: repo.private ?? null,
      description: repo.description ?? null,
      defaultBranch: repo.default_branch ?? null,
      pushedAt: repo.pushed_at ?? null,
      updatedAt: null,
      url: repo.html_url ?? null,
    });
  }

  const projects = [...merged.values()].sort((a, b) => {
    const ta = (a.pushedAt as string | null) ?? (a.updatedAt as string | null) ?? "";
    const tb = (b.pushedAt as string | null) ?? (b.updatedAt as string | null) ?? "";
    return String(tb).localeCompare(String(ta));
  });

  return NextResponse.json({ projects, warnings });
}
