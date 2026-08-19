import { NextRequest, NextResponse } from "next/server";
import { bridgeFetch } from "@/lib/bridge";
import { withProfile } from "@/lib/profiles";

// Set session model: POST /api/chat/sessions/[id]/model — forwarded to the Hermes API.
// ?profile=<id> routes to that Hermes multiplex profile.

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = await request.json().catch(() => ({}));
    const profile = (body as { profile?: string })?.profile ?? "";
    const path = withProfile(`/api/sessions/${id}/model`, profile);
    const resp = await bridgeFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const data = await resp.json().catch(() => ({}));
    return NextResponse.json(data, { status: resp.status });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
