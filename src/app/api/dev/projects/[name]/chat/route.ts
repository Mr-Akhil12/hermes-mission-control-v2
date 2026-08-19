import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  ghFetch,
  GH_OWNER_CONST,
  type GhRepo,
  type GhCommit,
} from "../../../_shared";
import { DEFAULT_MODEL } from "@/lib/models";

// POST /api/dev/projects/[name]/chat — project-bound chat.
// Builds a project-aware system prompt, then dispatches to the Hermes API
// exactly like /api/dispatch does (with Turso queue fallback).

const TURSO_URL = process.env.TURSO_URL ?? "";
const TURSO_TOKEN = process.env.TURSO_TOKEN ?? "";

interface TursoRow {
  [key: string]: unknown;
}

async function tursoQuery(sql: string, args: unknown[] = []): Promise<TursoRow[]> {
  const body = JSON.stringify({
    requests: [
      {
        type: "execute",
        stmt: {
          sql,
          args: args.map((v) =>
            v == null
              ? { type: "null", value: null }
              : typeof v === "number"
                ? { type: "integer", value: String(v) }
                : { type: "text", value: String(v) }
          ),
        },
      },
    ],
  });
  const res = await fetch(`${TURSO_URL}/v2/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TURSO_TOKEN}`, "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(8000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`turso ${res.status}`);
  const data = await res.json();
  const result = data?.results?.[0]?.response?.result;
  if (!result) return [];
  const cols: string[] = result.cols.map((c: { name: string }) => c.name);
  return result.rows.map((row: unknown[]) =>
    Object.fromEntries(row.map((v, i) => [cols[i], (v as { value?: unknown })?.value]))
  );
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const owner = GH_OWNER_CONST;

  let message: string;
  try {
    const body = await request.json();
    message = body?.message;
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  if (!message || typeof message !== "string") {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  // Gather project context for the system prompt.
  let branch = "main";
  let recentCommits: string[] = [];
  try {
    const repo = await ghFetch<GhRepo>(`/repos/${owner}/${name}`);
    branch = repo?.default_branch ?? "main";
  } catch {
    // fall back to defaults
  }
  try {
    const commits = await ghFetch<GhCommit[]>(`/repos/${owner}/${name}/commits?per_page=5`);
    recentCommits = (commits ?? []).map((c) => c.commit?.message ?? "").filter(Boolean);
  } catch {
    // fall back to empty
  }

  const systemPrompt = `You are working on the ${name} project. Repo: ${owner}/${name} (branch: ${branch}). Recent commits: ${recentCommits.join(" | ") || "none"}. The user wants to work on this project. Respond helpfully — you can suggest commands, explain the codebase, or plan changes. You do NOT have direct repo access from this chat; the user will run commands or ask you to prepare them.`;

  try {
    const apiBase = process.env.HERMES_API_URL ?? "http://127.0.0.1:8642";
    const DATA_URL = process.env.NEXT_PUBLIC_DATA_URL ?? "";
    const proxyBase = DATA_URL && apiBase.startsWith("http://127.0.0.1") ? DATA_URL : apiBase;

    const body = {
      input: `[dev:${name}] ${message}`,
      model: process.env.HERMES_API_MODEL ?? DEFAULT_MODEL,
      system: systemPrompt,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const bridgeToken = process.env.STATE_BRIDGE_TOKEN ?? "";
      if (bridgeToken) headers["Authorization"] = `Bearer ${bridgeToken}`;
      const res = await fetch(`${proxyBase}/v1/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.ok) {
        const data = await res.json();
        return NextResponse.json({
          ok: true,
          message: data.run_id ? `Run started (${data.run_id}). If it needs approval, it'll appear on the Approvals screen.` : "Run started.",
          run_id: data.run_id ?? null,
          queued: false,
        });
      }
    } catch {
      clearTimeout(timer);
    }

    // Fall back to Turso queue.
    if (!TURSO_URL || !TURSO_TOKEN) {
      return NextResponse.json(
        { error: "Hermes API unreachable and Turso queue not configured — dispatch failed." },
        { status: 502 }
      );
    }
    await tursoQuery(
      "INSERT INTO tasks (prompt, profile, status, source) VALUES (?, ?, 'queued', 'pwa')",
      [`[dev:${name}] ${message}`, "default"]
    );
    return NextResponse.json({
      ok: true,
      message: "Queued — Hermes API was unreachable, so this task is in the queue. The bridge will pick it up within 30s.",
      run_id: null,
      queued: true,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Dispatch failed: ${msg}` }, { status: 502 });
  }
}
