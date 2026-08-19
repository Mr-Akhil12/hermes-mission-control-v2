import { NextRequest, NextResponse } from "next/server";

// Attachment upload: POST /api/chat/attach
// The browser sends base64 JSON; this proxies to the state server which saves
// the file to ~/.hermes/attachments on the Hermes machine, so the agent's
// file tools can read it next turn.
const DATA_URL = process.env.NEXT_PUBLIC_DATA_URL ?? "";
const BRIDGE_TOKEN = process.env.STATE_BRIDGE_TOKEN ?? "";

function apiBase() {
  return DATA_URL || "http://127.0.0.1:8645";
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (BRIDGE_TOKEN) headers["Authorization"] = `Bearer ${BRIDGE_TOKEN}`;
    const resp = await fetch(`${apiBase()}/api/chat/attach`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const data = await resp.json();
    return NextResponse.json(data, { status: resp.status });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
