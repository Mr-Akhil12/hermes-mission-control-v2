import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const { prompt, profile } = await request.json();
    if (!prompt || typeof prompt !== "string") {
      return NextResponse.json({ error: "prompt is required" }, { status: 400 });
    }

    const apiBase = process.env.HERMES_API_URL ?? "http://127.0.0.1:8642";
    const DATA_URL = process.env.NEXT_PUBLIC_DATA_URL ?? "";
    const proxyBase = DATA_URL && apiBase.startsWith("http://127.0.0.1") ? DATA_URL : apiBase;

    // Start a real API run. Dangerous commands in the run park in
    // `waiting_for_approval` — surfaced on the Approvals screen.
    const body = {
      input: `[dispatch:${profile}] ${prompt}`,
      model: process.env.HERMES_API_MODEL ?? "deepseek-v4-flash:0731",
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);

    const res = await fetch(`${proxyBase}/v1/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json({ error: `Hermes API ${res.status}: ${text.slice(0, 200)}` }, { status: 502 });
    }

    const data = await res.json();
    return NextResponse.json({
      ok: true,
      message: data.run_id ? `Run started (${data.run_id}). If it needs approval, it'll appear on the Approvals screen.` : "Run started.",
      run_id: data.run_id ?? null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isAbort = msg.includes("abort") || msg.includes("Abort");
    return NextResponse.json(
      { error: isAbort ? "Hermes API timed out (30s)" : `Dispatch failed: ${msg}` },
      { status: 502 }
    );
  }
}
