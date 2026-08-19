import { NextRequest } from "next/server";
import { bridgeFetch } from "@/lib/bridge";

// Reattach stream: GET /api/chat/sessions/[id]/events?since=<seq>
// Proxies the Hermes API's reattachable run stream (via state server tunnel).
// Replays missed events (reasoning/tools/messages) since the client's last
// seen seq, then tails live — so leaving the page or hopping devices never
// breaks the stream.

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const since = request.nextUrl.searchParams.get("since") ?? "0";

  const upstream = await bridgeFetch(`/api/sessions/${id}/events?since=${since}`, {
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
