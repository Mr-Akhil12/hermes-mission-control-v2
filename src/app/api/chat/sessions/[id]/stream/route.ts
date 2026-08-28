import { NextRequest } from "next/server";
import { bridgeFetch } from "@/lib/bridge";
import { withProfile } from "@/lib/profiles";

// Streaming chat: POST /api/chat/sessions/[id]/stream
// Pipes SSE from the Hermes API (via state server tunnel) straight to the
// browser so tokens + thinking appear in real time.
// ?profile=<id> routes to that Hermes multiplex profile.
//
// maxDuration: this function pipes the WHOLE live run — thinking prefill on
// big sessions alone can exceed a minute. The platform default (30s) made
// Vercel kill the pipe mid-run; the API server then saw its SSE client
// disconnect and INTERRUPTED the live run (2026-08-28 Hush incident: 30.0s
// cut, eternal "thinking"). 300s = Fluid max on Hobby; Vercel clamps to the
// plan limit automatically.
export const maxDuration = 300;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const profile = (body as { profile?: string })?.profile ?? "";

  const path = withProfile(`/api/sessions/${id}/chat/stream`, profile);
  const upstream = await bridgeFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return new Response(text || `upstream ${upstream.status}`, {
      status: upstream.status,
    });
  }

  // Pipe the SSE stream through unchanged.
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

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
