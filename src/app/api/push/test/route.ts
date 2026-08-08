import { NextResponse } from "next/server";

// Push test — send a test notification to all subscriptions.
const DATA_URL = process.env.NEXT_PUBLIC_DATA_URL ?? "";

function apiBase() {
  return DATA_URL || "http://127.0.0.1:8645";
}

export async function POST() {
  try {
    const resp = await fetch(`${apiBase()}/api/push/test`, {
      method: "POST",
      cache: "no-store",
    });
    const data = await resp.json();
    return NextResponse.json(data, { status: resp.status });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
