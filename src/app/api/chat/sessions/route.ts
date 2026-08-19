import { NextRequest, NextResponse } from "next/server";
import { bridgeFetch } from "@/lib/bridge";

// Chat sessions: list + create, proxied to the Hermes API via the state
// server tunnel (ngrok → :8645 → :8642). The browser never sees the API key.

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    // source=all must look deep enough that real (older) conversations aren't
    // buried below the constant cron/subagent flood — cron runs every few
    // minutes, so a 50-cap hides dashboard chats started yesterday.
    const source = searchParams.get("source") ?? "dashboard";
    const limit = searchParams.get("limit") ?? (source === "all" ? "200" : "50");
    const resp = await bridgeFetch(`/api/sessions?limit=${limit}&source=${source}`, {
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
    const resp = await bridgeFetch("/api/sessions", {
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
