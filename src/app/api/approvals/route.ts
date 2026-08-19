import { NextRequest, NextResponse } from "next/server";
import { bridgeFetch } from "@/lib/bridge";

// Approvals: GET list (from state server local store) + POST resolve
// (forward to Hermes API /v1/runs/{run_id}/approval).

export async function GET() {
  try {
    const resp = await bridgeFetch("/api/approvals", { cache: "no-store" });
    const data = await resp.json();
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { runId, choice, all } = await request.json();
    if (!runId || !choice) {
      return NextResponse.json({ error: "runId and choice required" }, { status: 400 });
    }
    const resp = await bridgeFetch(`/v1/runs/${runId}/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ choice, all: Boolean(all) }),
      cache: "no-store",
    });
    const data = await resp.json();
    return NextResponse.json(data, { status: resp.status });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
