import { NextRequest, NextResponse } from "next/server";

// Approvals: GET list (from state server local store) + POST resolve
// (forward to Hermes API /v1/runs/{run_id}/approval).
const DATA_URL = process.env.NEXT_PUBLIC_DATA_URL ?? "";

function apiBase() {
  return DATA_URL || "http://127.0.0.1:8645";
}

export async function GET() {
  try {
    const resp = await fetch(`${apiBase()}/api/approvals`, { cache: "no-store" });
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
    const resp = await fetch(`${apiBase()}/v1/runs/${runId}/approval`, {
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
