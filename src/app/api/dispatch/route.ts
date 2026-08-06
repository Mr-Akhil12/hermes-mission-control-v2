import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const { prompt, profile } = await request.json();
    if (!prompt || typeof prompt !== "string") {
      return NextResponse.json({ error: "prompt is required" }, { status: 400 });
    }

    // Local Hermes dispatch via the API server (:8642). Phase 2 swaps this to
    // the Turso queue + bridge so the task survives tunnel drops.
    const apiBase = process.env.HERMES_API_URL ?? "http://127.0.0.1:8642";
    // On Vercel (phone), route chat through the tunneled state server proxy
    const DATA_URL = process.env.NEXT_PUBLIC_DATA_URL ?? "";
    const proxyBase = DATA_URL && !apiBase.startsWith("http://127.0.0.1") && apiBase === "http://127.0.0.1:8642"
      ? DATA_URL
      : apiBase;
    const model = process.env.HERMES_API_MODEL ?? undefined;
    const body: Record<string, unknown> = {
      model: model ?? "deepseek-v4-flash:0731",
      messages: [{ role: "user", content: `[dispatch:${profile}] ${prompt}` }],
      stream: false,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);

    const res = await fetch(`${proxyBase}/v1/chat/completions`, {
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
    const message = data?.choices?.[0]?.message?.content ?? "(no response)";
    return NextResponse.json({ ok: true, message });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isAbort = msg.includes("abort") || msg.includes("Abort");
    return NextResponse.json(
      { error: isAbort ? "Hermes API timed out (90s)" : `Dispatch failed: ${msg}` },
      { status: 502 }
    );
  }
}
