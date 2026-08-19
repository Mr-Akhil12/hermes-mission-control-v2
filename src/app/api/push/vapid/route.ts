import { NextRequest, NextResponse } from "next/server";
import { bridgeFetch } from "@/lib/bridge";

// Push VAPID public key — served to the browser so it can subscribe.

export async function GET() {
  try {
    const resp = await bridgeFetch("/api/push/vapid", { cache: "no-store" });
    const data = await resp.json();
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
