import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  ghFetch,
  filterTree,
  GH_OWNER_CONST,
  type GhRepo,
  type GhTree,
} from "../../../_shared";

// GET /api/dev/projects/[name]/tree — full recursive file tree via the git trees API.

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const owner = GH_OWNER_CONST;

  try {
    // Resolve the default branch first, then fetch the full recursive tree.
    const repo = await ghFetch<GhRepo>(`/repos/${owner}/${name}`);
    const branch = repo?.default_branch ?? "main";
    const treeRes = await ghFetch<GhTree>(
      `/repos/${owner}/${name}/git/trees/${branch}?recursive=1`
    );

    const rawTree = treeRes?.tree ?? [];
    const tree = filterTree(rawTree);

    return NextResponse.json({
      tree,
      truncated: Boolean(treeRes?.truncated),
      branch,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg, tree: [], truncated: false }, { status: 502 });
  }
}
