import { NextRequest, NextResponse } from "next/server";
import { bridgeFetch } from "@/lib/bridge";

// Chat sessions: list + create, proxied to the Hermes API via the state
// server tunnel (ngrok → :8645 → :8642). The browser never sees the API key.

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = searchParams.get("limit") ?? "50";
    const source = searchParams.get("source") ?? "dashboard";
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
