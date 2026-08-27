import { NextRequest, NextResponse } from "next/server";
import { bridgeFetch } from "@/lib/bridge";

export async function POST(request: NextRequest) {
  try {
    const body = await request.text();
    const response = await bridgeFetch("/api/push/watch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));
    return NextResponse.json(payload, { status: response.status });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 502 });
  }
}
