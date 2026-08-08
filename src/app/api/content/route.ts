import { NextRequest, NextResponse } from "next/server";

// Content Studio: GET cards (from vault via state server) + POST status update.
const DATA_URL = process.env.NEXT_PUBLIC_DATA_URL ?? "";

function apiBase() {
  return DATA_URL || "http://127.0.0.1:8645";
}

export async function GET() {
  try {
    const resp = await fetch(`${apiBase()}/api/content`, { cache: "no-store" });
    const data = await resp.json();
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.text();
    const resp = await fetch(`${apiBase()}/api/content/status`, {
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
