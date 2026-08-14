import { NextRequest, NextResponse } from "next/server";

// Browser view proxy: GET /api/browser/shot
// Returns the latest headed-browser screenshot (JPEG) from the state server
// so the chat page can show what the agent is doing in the browser.
const DATA_URL = process.env.NEXT_PUBLIC_DATA_URL ?? "";

function apiBase() {
  return DATA_URL || "http://127.0.0.1:8645";
}

export async function GET(_request: NextRequest) {
  try {
    const resp = await fetch(`${apiBase()}/api/browser/shot`, {
      cache: "no-store",
    });
    if (!resp.ok) {
      return NextResponse.json({ error: `browser shot failed (${resp.status})` }, { status: resp.status });
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    return new NextResponse(buf, {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
