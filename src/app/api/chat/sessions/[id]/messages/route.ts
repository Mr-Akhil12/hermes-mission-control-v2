import { NextRequest, NextResponse } from "next/server";
import { bridgeFetch } from "@/lib/bridge";
import { withProfile } from "@/lib/profiles";

// Session messages: GET /api/chat/sessions/[id]/messages?profile=<id>

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const profile = request.nextUrl.searchParams.get("profile") ?? "";
  try {
    const path = withProfile(`/api/sessions/${id}/messages`, profile);
    const resp = await bridgeFetch(path, {
      cache: "no-store",
    });
    const data = await resp.json();
    return NextResponse.json(data, { status: resp.status });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
