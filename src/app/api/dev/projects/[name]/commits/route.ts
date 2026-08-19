import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  ghFetch,
  GH_OWNER_CONST,
  type GhRepo,
  type GhCommit,
} from "../../../_shared";

// GET /api/dev/projects/[name]/commits — recent commits + repo info.

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const owner = GH_OWNER_CONST;

  const [commitsRes, repoRes] = await Promise.allSettled([
    ghFetch<GhCommit[]>(`/repos/${owner}/${name}/commits?per_page=15`),
    ghFetch<GhRepo>(`/repos/${owner}/${name}`),
  ]);

  let commits: Record<string, unknown>[] = [];
  if (commitsRes.status === "fulfilled") {
    commits = (commitsRes.value ?? []).map((c) => ({
      sha: c.sha ?? null,
      message: c.commit?.message ?? "",
      author: c.author?.login ?? c.commit?.author?.name ?? "unknown",
      date: c.commit?.author?.date ?? null,
    }));
  }

  let branch: string | null = null;
  let pushedAt: string | null = null;
  if (repoRes.status === "fulfilled") {
    branch = repoRes.value?.default_branch ?? null;
    pushedAt = repoRes.value?.pushed_at ?? null;
  }

  return NextResponse.json({ commits, branch, pushedAt });
}
