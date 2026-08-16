import { NextRequest } from "next/server";

// Reattach stream: GET /api/chat/sessions/[id]/events?since=<seq>
// Proxies the Hermes API's reattachable run stream (via state server tunnel).
// Replays missed events (reasoning/tools/messages) since the client's last
// seen seq, then tails live — so leaving the page or hopping devices never
// breaks the stream.
const DATA_URL = process.env.NEXT_PUBLIC_DATA_URL ?? "";

function apiBase() {
  return DATA_URL || "http://127.0.0.1:8645";
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const since = request.nextUrl.searchParams.get("since") ?? "0";

  const upstream = await fetch(`${apiBase()}/api/sessions/${id}/events?since=${since}`, {
    cache: "no-store",
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return new Response(text || `upstream ${upstream.status}`, {
      status: upstream.status,
    });
  }

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
