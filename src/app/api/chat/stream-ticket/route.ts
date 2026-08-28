import { NextRequest, NextResponse } from "next/server";
import { bridgeFetch } from "@/lib/bridge";

// Mint a short-lived single-use stream ticket for direct-to-funnel chat
// streaming. The browser NEVER sees STATE_BRIDGE_TOKEN — this route holds it
// server-side, the state server validates it, and the browser receives only
// an HMAC ticket that binds one session_id and dies in 120s / first use.
//
// Why: Vercel functions cap SSE pipes (clamped at 30s on this plan even with
// maxDuration), which decapitated long-run streams mid-flight. The browser
// now streams straight from the Tailscale funnel — a raw proxy with no
// function cap — using the ticket.

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const sessionId = (body as { session_id?: string })?.session_id ?? "";
    if (!sessionId || sessionId.length > 160) {
      return NextResponse.json({ error: "session_id required" }, { status: 400 });
    }
    const resp = await bridgeFetch("/api/stream-ticket", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId }),
      cache: "no-store",
    });
    const data = await resp.json();
    return NextResponse.json(data, { status: resp.status });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}