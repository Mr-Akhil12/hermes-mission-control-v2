import { NextRequest, NextResponse } from "next/server";
import { bridgeFetch } from "@/lib/bridge";
import { withProfile } from "@/lib/profiles";

// Session mutations: PATCH /api/chat/sessions/[id] (title, end_reason)
// DELETE /api/chat/sessions/[id] — forwarded to the Hermes API.
// ?profile=<id> routes to that Hermes multiplex profile.

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = await request.json().catch(() => ({}));
    const profile = request.nextUrl.searchParams.get("profile") ?? "";
    const path = withProfile(`/api/sessions/${id}`, profile);
    const resp = await bridgeFetch(path, {
      method: "PATCH",
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

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const profile = request.nextUrl.searchParams.get("profile") ?? "";
  try {
    const path = withProfile(`/api/sessions/${id}`, profile);
    const resp = await bridgeFetch(path, {
      method: "DELETE",
      cache: "no-store",
    });
    const data = await resp.json().catch(() => ({}));
    return NextResponse.json(data, { status: resp.status });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
