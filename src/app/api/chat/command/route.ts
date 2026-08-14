import { NextRequest, NextResponse } from "next/server";

// Full command bridge: POST /api/chat/command
// Forwards to the state server which runs ANY slash command through the
// native dashboard's JSON-RPC WebSocket (slash.exec / command.dispatch).
const DATA_URL = process.env.NEXT_PUBLIC_DATA_URL ?? "";

function apiBase() {
  return DATA_URL || "http://127.0.0.1:8645";
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const resp = await fetch(`${apiBase()}/api/chat/command`, {
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
