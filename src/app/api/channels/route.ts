import { NextResponse } from "next/server";
import { bridgeFetch } from "@/lib/bridge";

// Channels: real gateway state via the state server.

export async function GET() {
  try {
    const resp = await bridgeFetch("/api/channels", { cache: "no-store" });
    const data = await resp.json();
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
