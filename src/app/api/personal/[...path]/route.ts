import { NextRequest, NextResponse } from "next/server";

// Personal: Hermes memory + Obsidian vault via the state server.
const DATA_URL = process.env.NEXT_PUBLIC_DATA_URL ?? "";

function apiBase() {
  return DATA_URL || "http://127.0.0.1:8645";
}

export async function GET(request: NextRequest) {
  try {
    const { pathname } = new URL(request.url);
    const rest = pathname.replace("/api/personal", "");
    // State server endpoints are /api/memory, /api/vault, etc. — re-add the
    // /api prefix that the catch-all stripped.
    const target = `/api${rest.startsWith("/") ? rest : `/${rest}`}`;
    const resp = await fetch(`${apiBase()}${target}`, { cache: "no-store" });
    const data = await resp.json();
    return NextResponse.json(data, { status: resp.status });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
