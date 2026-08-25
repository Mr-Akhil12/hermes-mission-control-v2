import { NextRequest, NextResponse } from "next/server";
import { bridgeFetch } from "@/lib/bridge";
import { withProfile } from "@/lib/profiles";

type SessionRecord = {
  id: string;
  title?: string | null;
  [key: string]: unknown;
};

type SessionList = {
  data?: SessionRecord[];
  sessions?: SessionRecord[];
};

class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

function projectSessionTitle(name: string): string {
  return `[dev:${name}]`;
}

function errorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const record = payload as Record<string, unknown>;
  if (typeof record.error === "string") return record.error;
  if (record.error && typeof record.error === "object") {
    const nested = record.error as Record<string, unknown>;
    if (typeof nested.message === "string") return nested.message;
  }
  return fallback;
}

async function findProjectSession(
  name: string,
  profile: string
): Promise<SessionRecord | null> {
  const path = withProfile("/api/sessions?limit=200&source=all", profile);
  const response = await bridgeFetch(path, { cache: "no-store" });
  const payload = (await response.json().catch(() => ({}))) as SessionList &
    Record<string, unknown>;

  if (!response.ok) {
    throw new UpstreamError(
      errorMessage(payload, `Session lookup failed (${response.status})`),
      response.status
    );
  }

  const expectedTitle = projectSessionTitle(name);
  // The state server's local /api/sessions returns { sessions: [...] } while
  // the Hermes API returns { data: [...] } — accept both shapes.
  const list = payload.sessions ?? payload.data ?? [];
  return list.find((session) => session.title === expectedTitle) ?? null;
}

function errorResponse(error: unknown) {
  if (error instanceof UpstreamError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: 502 }
  );
}

// GET /api/dev/projects/[name]/chat
// Resolve the one exact-title project session and return its persisted history.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const profile = request.nextUrl.searchParams.get("profile") ?? "";

  try {
    const session = await findProjectSession(name, profile);
    if (!session) {
      return NextResponse.json({ session: null, messages: [] });
    }

    const path = withProfile(
      `/api/sessions/${encodeURIComponent(session.id)}/messages`,
      profile
    );
    const response = await bridgeFetch(path, { cache: "no-store" });
    const payload = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    if (!response.ok) {
      throw new UpstreamError(
        errorMessage(payload, `Message history failed (${response.status})`),
        response.status
      );
    }

    return NextResponse.json({
      session,
      messages: Array.isArray(payload.data) ? payload.data : [],
    });
  } catch (error) {
    return errorResponse(error);
  }
}

// POST /api/dev/projects/[name]/chat
// Lazily create the exact-title session. The stream route owns message sending.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    profile?: unknown;
  };
  const profile = typeof body.profile === "string" ? body.profile : "";

  try {
    const existing = await findProjectSession(name, profile);
    if (existing) {
      return NextResponse.json({
        ok: true,
        sessionId: existing.id,
        session: existing,
        created: false,
      });
    }

    const title = projectSessionTitle(name);
    const path = withProfile("/api/sessions", profile);
    const response = await bridgeFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "dashboard", title }),
      cache: "no-store",
    });
    const payload = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const createdSession =
      payload.session && typeof payload.session === "object"
        ? (payload.session as SessionRecord)
        : null;

    if (response.ok && createdSession?.id) {
      return NextResponse.json({
        ok: true,
        sessionId: createdSession.id,
        session: createdSession,
        created: true,
      });
    }

    // Hermes enforces unique titles. If two first messages race, the losing
    // create can safely resolve the winner instead of creating a second chat.
    const racedSession = await findProjectSession(name, profile).catch(() => null);
    if (racedSession) {
      return NextResponse.json({
        ok: true,
        sessionId: racedSession.id,
        session: racedSession,
        created: false,
      });
    }

    throw new UpstreamError(
      errorMessage(payload, `Session creation failed (${response.status})`),
      response.status
    );
  } catch (error) {
    return errorResponse(error);
  }
}
