"use client";

import { useState } from "react";
import { Send, MessageSquare } from "lucide-react";

type Channel = { id: string; name: string; status: "connected" | "disconnected"; last: string };

const DEMO_CHANNELS: Channel[] = [
  { id: "discord", name: "Discord", status: "connected", last: "2 min ago" },
  { id: "telegram", name: "Telegram", status: "connected", last: "1 h ago" },
  { id: "whatsapp", name: "WhatsApp", status: "disconnected", last: "never" },
  { id: "email", name: "Email (Gmail)", status: "connected", last: "12 min ago" },
  { id: "webhook", name: "Webhook", status: "connected", last: "4 min ago" },
  { id: "api", name: "API server :8642", status: "connected", last: "just now" },
];

export default function ChannelsPage() {
  const [channels] = useState<Channel[]>(DEMO_CHANNELS);
  const [composer, setComposer] = useState<{ to: string; text: string } | null>(null);
  const [sent, setSent] = useState<string[]>([]);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Channels</h1>
        <p className="text-sm" style={{ color: "var(--text-dim)" }}>Message layer integrations at a glance.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {channels.map((c) => (
          <div key={c.id} className="card p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-semibold">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: c.status === "connected" ? "var(--green)" : "var(--red)" }} />
                {c.name}
              </div>
              <button
                onClick={() => setComposer({ to: c.name, text: "" })}
                className="rounded-lg p-1.5"
                style={{ color: "var(--accent)", background: "rgba(124,108,255,0.10)" }}
                aria-label={`Send to ${c.name}`}
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="mt-2 text-xs" style={{ color: "var(--text-faint)" }}>
              {c.status === "connected" ? `Last activity ${c.last}` : "Not connected"}
            </div>
          </div>
        ))}
      </div>

      {composer && (
        <div className="card fixed inset-x-4 bottom-20 z-50 mx-auto max-w-lg p-5 md:bottom-8">
          <h3 className="mb-2 flex items-center gap-2 font-semibold">
            <MessageSquare className="h-4 w-4" style={{ color: "var(--accent)" }} /> Send to {composer.to}
          </h3>
          <textarea
            value={composer.text}
            onChange={(e) => setComposer({ ...composer, text: e.target.value })}
            rows={3}
            placeholder="Message…"
            className="w-full resize-none rounded-lg border bg-transparent p-3 text-sm outline-none"
            style={{ borderColor: "var(--card-border)", color: "var(--text)" }}
          />
          <div className="mt-2 flex justify-end gap-2">
            <button onClick={() => setComposer(null)} className="rounded-lg border px-3 py-1.5 text-sm" style={{ borderColor: "var(--card-border)" }}>
              Cancel
            </button>
            <button
              onClick={() => {
                if (composer.text.trim()) {
                  setSent((s) => [`${composer.to}: ${composer.text}`, ...s]);
                  setComposer(null);
                }
              }}
              className="rounded-lg px-3 py-1.5 text-sm font-semibold text-white"
              style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
            >
              Send
            </button>
          </div>
        </div>
      )}

      {sent.length > 0 && (
        <section className="card p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>Delivery log</h2>
          <ul className="space-y-2 text-sm" style={{ color: "var(--text-dim)" }}>
            {sent.map((s, i) => <li key={i}>✓ {s}</li>)}
          </ul>
        </section>
      )}
    </div>
  );
}
