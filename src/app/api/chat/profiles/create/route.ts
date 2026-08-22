import { NextRequest, NextResponse } from "next/server";
import { bridgeFetch } from "@/lib/bridge";

// POST /api/chat/profiles/create — create a new multiplex profile (bot)
// Body: { name, description?, model?, provider?, clone_from? }

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const resp = await bridgeFetch("/api/profiles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const data = await resp.json();
    return NextResponse.json(data, { status: resp.status });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
