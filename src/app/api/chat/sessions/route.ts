import { NextRequest, NextResponse } from "next/server";

// Chat sessions: list + create, proxied to the Hermes API via the state
// server tunnel (ngrok → :8645 → :8642). The browser never sees the API key.
const DATA_URL = process.env.NEXT_PUBLIC_DATA_URL ?? "";

function apiBase() {
  return DATA_URL || "http://127.0.0.1:8645";
}

export async function GET() {
  try {
    const resp = await fetch(`${apiBase()}/api/sessions?limit=50`, {
      cache: "no-store",
    });
    const data = await resp.json();
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const resp = await fetch(`${apiBase()}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "dashboard", ...body }),
      cache: "no-store",
    });
    const data = await resp.json();
    return NextResponse.json(data, { status: resp.status });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
