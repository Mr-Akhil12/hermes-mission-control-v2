import { NextRequest, NextResponse } from "next/server";
import { bridgeFetch } from "@/lib/bridge";

// Slash command execution: POST /api/chat/slash
// Forwards to the state server which runs registry-owned Hermes executors.

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const resp = await bridgeFetch("/api/chat/slash", {
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
