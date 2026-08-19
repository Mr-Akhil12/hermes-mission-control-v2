import { NextRequest, NextResponse } from "next/server";
import { bridgeFetch } from "@/lib/bridge";

// Browser view stream: GET /api/browser/shot
// Proxies the live MJPEG stream (multipart/x-mixed-replace) from the state
// server — the chat page <img> plays it directly, no polling, no bloat.

export async function GET(_request: NextRequest) {
  try {
    const upstream = await bridgeFetch("/api/browser/shot", {
      cache: "no-store",
    });
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json(
        { error: `browser stream failed (${upstream.status})` },
        { status: upstream.status ?? 502 }
      );
    }
    // Pipe the MJPEG stream through as-is.
    const reader = upstream.body.getReader();
    const stream = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      },
      cancel() {
        reader.cancel().catch(() => {});
      },
    });
    return new NextResponse(stream, {
      status: 200,
      headers: {
        "Content-Type": "multipart/x-mixed-replace; boundary=frame",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
