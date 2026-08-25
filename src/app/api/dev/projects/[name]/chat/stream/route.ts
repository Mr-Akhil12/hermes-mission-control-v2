import type { NextRequest } from "next/server";
import { bridgeFetch } from "@/lib/bridge";
import { withProfile } from "@/lib/profiles";
import {
  filterTree,
  ghFetch,
  GH_OWNER_CONST,
  type GhCommit,
  type GhRepo,
  type GhTree,
} from "../../../../_shared";

type SessionRecord = {
  id: string;
  title?: string | null;
};

type StreamRequest = {
  sessionId?: unknown;
  message?: unknown;
  messages?: unknown;
  profile?: unknown;
  model?: unknown;
};

function projectTitle(name: string): string {
  return `[dev:${name}]`;
}

function lastUserMessage(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.role === "user" && typeof record.content === "string") {
      return record.content.trim();
    }
  }
  return "";
}

async function assertProjectSession(
  name: string,
  sessionId: string,
  profile: string
): Promise<void> {
  const path = withProfile("/api/sessions?limit=200&source=all", profile);
  const response = await bridgeFetch(path, { cache: "no-store" });
  const payload = (await response.json().catch(() => ({}))) as {
    data?: SessionRecord[];
    sessions?: SessionRecord[];
  };

  if (!response.ok) {
    throw new Error(`Session lookup failed (${response.status})`);
  }

  // The state server's local /api/sessions returns { sessions: [...] } while
  // the Hermes API returns { data: [...] } — accept both shapes.
  const list = payload.sessions ?? payload.data ?? [];
  const matching = list.find(
    (session) => session.title === projectTitle(name)
  );
  if (!matching || matching.id !== sessionId) {
    throw new Error("Session does not belong to this project");
  }
}

async function projectSystemPrompt(name: string): Promise<string> {
  const owner = GH_OWNER_CONST;
  const [repoResult, commitsResult] = await Promise.allSettled([
    ghFetch<GhRepo>(`/repos/${owner}/${name}`),
    ghFetch<GhCommit[]>(`/repos/${owner}/${name}/commits?per_page=5`),
  ]);

  const branch =
    repoResult.status === "fulfilled"
      ? repoResult.value.default_branch || "main"
      : "main";
  const commits =
    commitsResult.status === "fulfilled"
      ? commitsResult.value
          .slice(0, 5)
          .map((commit) => {
            const summary = commit.commit?.message?.split("\n", 1)[0] || "(no message)";
            return `${commit.sha.slice(0, 7)} ${summary}`;
          })
      : [];

  let topLevel: string[] = [];
  try {
    const treeResult = await ghFetch<GhTree>(
      `/repos/${owner}/${name}/git/trees/${encodeURIComponent(branch)}?recursive=1`
    );
    topLevel = filterTree(treeResult.tree ?? [])
      .filter((entry) => !entry.path.includes("/"))
      .sort((left, right) => {
        if (left.type !== right.type) return left.type === "dir" ? -1 : 1;
        return left.path.localeCompare(right.path);
      })
      .map((entry) => `${entry.type === "dir" ? "dir" : "file"}: ${entry.path}`);
  } catch {
    topLevel = [];
  }

  return [
    `You are AKHIL, Akhil's orchestrator agent, working in the ${name} project (repo: ${owner}/${name}).`,
    "Direct, solution-oriented, acts-first. Bullets, no tables, times SAST.",
    "You have full context of this repo — plan changes, explain code, suggest commands, ask before destructive steps.",
    "You're a senior engineer who knows this codebase.",
    "",
    `Default branch: ${branch}`,
    "Recent commits:",
    ...(commits.length > 0 ? commits.map((commit) => `- ${commit}`) : ["- Unavailable"]),
    "Top-level tree:",
    ...(topLevel.length > 0 ? topLevel.map((entry) => `- ${entry}`) : ["- Unavailable"]),
  ].join("\n");
}

// POST /api/dev/projects/[name]/chat/stream
// The persisted session API reloads the complete transcript itself; this route
// adds project-specific orchestration instructions and pipes its SSE unchanged.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const body = (await request.json().catch(() => ({}))) as StreamRequest;
  const sessionId =
    typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const message =
    typeof body.message === "string"
      ? body.message.trim()
      : lastUserMessage(body.messages);
  const profile = typeof body.profile === "string" ? body.profile : "";

  if (!sessionId) {
    return Response.json({ error: "sessionId is required" }, { status: 400 });
  }
  if (!message) {
    return Response.json({ error: "message is required" }, { status: 400 });
  }

  try {
    await assertProjectSession(name, sessionId, profile);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 409 }
    );
  }

  const systemMessage = await projectSystemPrompt(name);
  const path = withProfile(
    `/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`,
    profile
  );
  const upstream = await bridgeFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      system_message: systemMessage,
      ...(typeof body.model === "string" && body.model
        ? { model: body.model }
        : {}),
    }),
    cache: "no-store",
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return new Response(text || `upstream ${upstream.status}`, {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("Content-Type") ?? "application/json",
      },
    });
  }

  const reader = upstream.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
    cancel() {
      reader.cancel().catch(() => undefined);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
