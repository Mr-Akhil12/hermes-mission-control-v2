"use client";

import { useState } from "react";
import { MessageSquare, RotateCcw, AlertCircle, CheckCircle2, Clock } from "lucide-react";

type Session = {
  id: string;
  title: string;
  source: string;
  ended_at: number | null;
  end_reason: string | null;
  message_count: number;
  last_message?: string;
};

const DEMO_SESSIONS: Session[] = [
  { id: "cron_52a661aaa177_20260806_030033", title: "nightly-obsidian-ideas · Aug 06 03:03", source: "cron", ended_at: 1785978238, end_reason: "completed", message_count: 41, last_message: "Everything built and verified…" },
  { id: "cron_f9f5939d3490_20260806_032033", title: "task-worker · Aug 06 03:21", source: "cron", ended_at: 1785979266, end_reason: "completed", message_count: 19, last_message: "[SILENT]" },
  { id: "20260805_172524_1b39f218", title: "Bursary Hunt for Richfield Comp Sci", source: "discord", ended_at: null, end_reason: null, message_count: 70, last_message: "Both files are done and verified…" },
];

export default function SessionsPage() {
  const [sessions] = useState<Session[]>(DEMO_SESSIONS);

  const statusIcon = (s: Session) => {
    if (s.ended_at === null) return <Clock className="h-4 w-4" style={{ color: "var(--amber)" }} />;
    if (s.end_reason === "completed") return <CheckCircle2 className="h-4 w-4" style={{ color: "var(--green)" }} />;
    if (s.end_reason === "error") return <AlertCircle className="h-4 w-4" style={{ color: "var(--red)" }} />;
    return <MessageSquare className="h-4 w-4" style={{ color: "var(--text-faint)" }} />;
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Sessions</h1>
        <p className="text-sm" style={{ color: "var(--text-dim)" }}>Every conversation, why it stopped, and what to do next.</p>
      </div>

      <div className="space-y-3">
        {sessions.map((s) => (
          <div key={s.id} className="card p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <span className="mt-0.5">{statusIcon(s)}</span>
                <div className="min-w-0">
                  <div className="font-semibold">{s.title}</div>
                  <div className="mt-0.5 text-xs" style={{ color: "var(--text-faint)" }}>
                    {s.id.slice(0, 40)}… · {s.message_count} messages
                  </div>
                  {s.last_message && (
                    <div className="mt-2 truncate rounded-lg p-2 text-xs" style={{ background: "color-mix(in srgb, var(--bg) 60%, transparent)", color: "var(--text-dim)" }}>
                      "{s.last_message}"
                    </div>
                  )}
                </div>
              </div>
              <span
                className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase"
                style={{
                  background: s.ended_at === null ? "rgba(255,180,84,0.12)" : s.end_reason === "error" ? "rgba(255,92,92,0.12)" : "rgba(61,220,151,0.12)",
                  color: s.ended_at === null ? "var(--amber)" : s.end_reason === "error" ? "var(--red)" : "var(--green)",
                }}
              >
                {s.ended_at === null ? "active" : s.end_reason ?? "stopped"}
              </span>
            </div>
            <div className="mt-3 flex items-center gap-3 text-xs" style={{ color: "var(--text-dim)" }}>
              <span>
                {s.ended_at
                  ? `Stopped ${new Date(s.ended_at * 1000).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" })}`
                  : "Still active"}
              </span>
              <button className="ml-auto flex items-center gap-1 font-semibold" style={{ color: "var(--accent)" }}>
                <RotateCcw className="h-3.5 w-3.5" /> Resume
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
