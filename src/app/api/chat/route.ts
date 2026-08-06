import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const { message, history } = await request.json();
    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "message required" }, { status: 400 });
    }

    const apiBase = process.env.HERMES_API_URL ?? "http://127.0.0.1:8642";
    // On Vercel (phone), route chat through the tunneled state server proxy
    const DATA_URL = process.env.NEXT_PUBLIC_DATA_URL ?? "";
    const proxyBase = DATA_URL && !apiBase.startsWith("http://127.0.0.1") && apiBase === "http://127.0.0.1:8642"
      ? DATA_URL
      : apiBase;
    const model = process.env.HERMES_API_MODEL ?? "deepseek-v4-flash:0731";

    const messages = [
      {
        role: "system",
        content:
          "You are Hermes, Akhil's personal AI agent, reached from the Hermes OS v2 Mission Control chat window. Be direct, warm, and solution-oriented. Use bullet points. Times in SAST.",
      },
      ...(Array.isArray(history)
        ? history.map((m: { role?: string; content?: string }) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content ?? "",
          })).filter((m) => m.content)
        : []),
      { role: "user", content: message },
    ];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);

    const res = await fetch(`${proxyBase}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: false }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json({ error: `Hermes API ${res.status}: ${text.slice(0, 200)}` }, { status: 502 });
    }

    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content ?? "(no response)";
    return NextResponse.json({ message: reply });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: msg.includes("abort") ? "Hermes API timed out (90s)" : `Chat failed: ${msg}` },
      { status: 502 }
    );
  }
}
