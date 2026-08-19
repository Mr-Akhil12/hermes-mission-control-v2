import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  ghFetch,
  vercelFetch,
  GH_OWNER_CONST,
  type GhDeployment,
  type VercelProject,
  type VercelDeployment,
} from "../../../_shared";

// GET /api/dev/projects/[name]/deployments — Vercel + GitHub deployments.

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const owner = GH_OWNER_CONST;

  // Resolve the Vercel project id first (if any), then fetch its deployments.
  let vercelId: string | null = null;
  try {
    const vp = await vercelFetch<{ projects: VercelProject[] }>("/v6/projects?limit=100");
    const projects = vp?.projects ?? [];
    const match =
      projects.find((p) => p.link?.repo === name) ??
      projects.find((p) => p.name === name) ??
      null;
    vercelId = match?.id ?? null;
  } catch {
    vercelId = null;
  }

  const [vercelRes, githubRes] = await Promise.allSettled([
    vercelId
      ? vercelFetch<{ deployments: VercelDeployment[] }>(
          `/v6/deployments?projectId=${vercelId}&limit=20`
        )
      : Promise.resolve(null),
    ghFetch<GhDeployment[]>(`/repos/${owner}/${name}/deployments?per_page=10`),
  ]);

  let vercel: Record<string, unknown>[] = [];
  if (vercelRes.status === "fulfilled" && vercelRes.value) {
    vercel = (vercelRes.value?.deployments ?? []).map((d) => ({
      uid: d.uid ?? null,
      url: d.url ?? null,
      readyState: d.readyState ?? null,
      target: d.target ?? null,
      created: d.created ?? null,
    }));
  }

  let github: Record<string, unknown>[] = [];
  if (githubRes.status === "fulfilled") {
    github = (githubRes.value ?? []).map((d) => ({
      id: d.id ?? null,
      ref: d.ref ?? null,
      environment: d.environment ?? null,
      created_at: d.created_at ?? null,
    }));
  }

  return NextResponse.json({ vercel, github });
}
