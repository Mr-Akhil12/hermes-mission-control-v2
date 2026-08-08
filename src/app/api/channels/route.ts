import { NextResponse } from "next/server";

// Channels: real gateway state via the state server.
const DATA_URL = process.env.NEXT_PUBLIC_DATA_URL ?? "";

function apiBase() {
  return DATA_URL || "http://127.0.0.1:8645";
}

export async function GET() {
  try {
    const resp = await fetch(`${apiBase()}/api/channels`, { cache: "no-store" });
    const data = await resp.json();
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
