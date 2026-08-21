import { NextRequest, NextResponse } from "next/server";
import { bridgeFetch } from "@/lib/bridge";

// GET /api/chat/delegations — recent subagent delegations (async_delegations
// table) for the Agents screen: who was spawned, what for, outcome.

export async function GET(_request: NextRequest) {
  try {
    const resp = await bridgeFetch("/api/delegations", { cache: "no-store" });
    const data = await resp.json();
    return NextResponse.json(data, { status: resp.status });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
