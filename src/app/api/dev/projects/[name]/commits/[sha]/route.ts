import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { ghFetch, GH_OWNER_CONST } from "../../../../_shared";

type GhCommitFile = {
  filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string;
};

type GhCommitDetail = {
  sha?: string;
  commit?: {
    message?: string;
    author?: { date?: string; name?: string } | null;
  };
  author?: { login?: string } | null;
  files?: GhCommitFile[];
};

// GET /api/dev/projects/[name]/commits/[sha] — one commit and its unified patches.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string; sha: string }> }
) {
  const { name, sha } = await params;

  try {
    const commit = await ghFetch<GhCommitDetail>(
      `/repos/${GH_OWNER_CONST}/${encodeURIComponent(name)}/commits/${encodeURIComponent(sha)}?per_page=50`
    );

    const files = (commit.files ?? []).slice(0, 50).map((file) => {
      const additions = file.additions ?? 0;
      const deletions = file.deletions ?? 0;
      const result: {
        filename: string;
        status: string;
        additions: number;
        deletions: number;
        changes: number;
        patch?: string;
      } = {
        filename: file.filename ?? "unknown",
        status: file.status ?? "modified",
        additions,
        deletions,
        changes: file.changes ?? additions + deletions,
      };

      if (typeof file.patch === "string") result.patch = file.patch;
      return result;
    });

    return NextResponse.json({
      sha: commit.sha ?? sha,
      message: commit.commit?.message ?? "",
      author: commit.author?.login ?? commit.commit?.author?.name ?? "unknown",
      date: commit.commit?.author?.date ?? null,
      files,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
