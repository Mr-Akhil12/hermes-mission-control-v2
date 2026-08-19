import { NextRequest, NextResponse } from "next/server";
import { bridgeFetch } from "@/lib/bridge";

// Push unsubscribe + test — proxied to the local state server.

export async function POST(request: NextRequest) {
  try {
    const body = await request.text();
    const resp = await bridgeFetch("/api/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      cache: "no-store",
    });
    const data = await resp.json();
    return NextResponse.json(data, { status: resp.status });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
