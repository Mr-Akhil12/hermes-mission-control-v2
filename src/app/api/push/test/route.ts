import { NextResponse } from "next/server";
import { bridgeFetch } from "@/lib/bridge";

// Push test — send a test notification to all subscriptions.

export async function POST() {
  try {
    const resp = await bridgeFetch("/api/push/test", {
      method: "POST",
      cache: "no-store",
    });
    const data = await resp.json();
    return NextResponse.json(data, { status: resp.status });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
