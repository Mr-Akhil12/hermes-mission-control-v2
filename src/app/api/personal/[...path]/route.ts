import { NextRequest, NextResponse } from "next/server";
import { bridgeFetch } from "@/lib/bridge";

// Personal: Hermes memory + Obsidian vault via the state server.

export async function GET(request: NextRequest) {
  try {
    const { pathname } = new URL(request.url);
    const rest = pathname.replace("/api/personal", "");
    // State server endpoints are /api/memory, /api/vault, etc. — re-add the
    // /api prefix that the catch-all stripped.
    const target = `/api${rest.startsWith("/") ? rest : `/${rest}`}`;
    const resp = await bridgeFetch(target, { cache: "no-store" });
    const data = await resp.json();
    return NextResponse.json(data, { status: resp.status });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
