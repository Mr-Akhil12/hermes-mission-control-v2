// Direct-to-funnel streaming: mint a short-lived single-use ticket via the
// same-origin Vercel route (which holds the bridge token server-side), then
// POST the chat stream straight to the Tailscale funnel. Vercel is never in
// the streaming path — its function cap can't kill long runs anymore.

const FUNNEL_BASE = "https://akhils-pc.tail6d629e.ts.net/state";

export async function mintStreamTicket(sessionId: string): Promise<string | null> {
  try {
    const res = await fetch("/api/chat/stream-ticket", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.ticket === "string" ? data.ticket : null;
  } catch {
    return null;
  }
}

export function directStreamUrl(sessionId: string): string {
  return `${FUNNEL_BASE}/api/sessions/${sessionId}/chat/stream`;
}

export function directStreamHeaders(ticket: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ticket ${ticket}`,
  };
}