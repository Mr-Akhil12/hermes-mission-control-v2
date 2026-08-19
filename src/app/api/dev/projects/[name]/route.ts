import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  ghFetch,
  vercelFetch,
  GH_OWNER_CONST,
  type GhRepo,
  type VercelProject,
} from "../../_shared";

// GET /api/dev/projects/[name] — GitHub repo info + Vercel project (by name).

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const owner = GH_OWNER_CONST;

  const [repoRes, vercelRes] = await Promise.allSettled([
    ghFetch<GhRepo>(`/repos/${owner}/${name}`),
    vercelFetch<{ projects: VercelProject[] }>("/v6/projects?limit=100"),
  ]);

  let repo: GhRepo | null = null;
  if (repoRes.status === "fulfilled") {
    repo = repoRes.value;
  }

  let vercel: Record<string, unknown> | null = null;
  if (vercelRes.status === "fulfilled") {
    const projects = vercelRes.value?.projects ?? [];
    const match =
      projects.find((p) => p.link?.repo === name) ??
      projects.find((p) => p.name === name) ??
      null;
    if (match) {
      vercel = {
        id: match.id ?? null,
        name: match.name ?? null,
        framework: match.framework ?? null,
        productionBranch: match.link?.productionBranch ?? null,
        updatedAt: match.updatedAt ?? null,
      };
    }
  }

  return NextResponse.json({ repo, vercel });
}
