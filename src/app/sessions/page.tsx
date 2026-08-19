"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { MessageSquare, RotateCcw, AlertCircle, CheckCircle2, Clock, Loader2 } from "lucide-react";
import { fmtSAST } from "@/lib/time";

type Session = {
  id: string;
  source: string;
  title: string | null;
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
  message_count: number;
  last_message?: string | null;
};

export default function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/sessions?limit=25")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setSessions(d.sessions ?? []);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const fmt = (ts: number | null) => (ts ? fmtSAST(ts * 1000) : "—");

  const statusIcon = (s: Session) => {
    if (s.ended_at === null) return <Clock className="h-4 w-4" style={{ color: "var(--amber)" }} />;
    if (s.end_reason === "cron_complete" || s.end_reason === "completed") return <CheckCircle2 className="h-4 w-4" style={{ color: "var(--green)" }} />;
    if (s.end_reason === "error" || s.end_reason === "failed") return <AlertCircle className="h-4 w-4" style={{ color: "var(--red)" }} />;
    return <MessageSquare className="h-4 w-4" style={{ color: "var(--text-faint)" }} />;
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Sessions</h1>
        <p className="text-sm" style={{ color: "var(--text-dim)" }}>
          Real conversations from the Hermes session store — why they stopped, and what to do next.
        </p>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin" style={{ color: "var(--accent)" }} />
        </div>
      )}

      {error && (
        <div className="card p-4 text-sm" style={{ color: "var(--red)" }}>Could not load sessions: {error}</div>
      )}

      {!loading && !error && (
        <div className="space-y-3">
          {sessions.map((s) => (
            <div key={s.id} className="card p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="mt-0.5">{statusIcon(s)}</span>
                  <div className="min-w-0">
                    <div className="font-semibold">{s.title || s.id.slice(0, 60)}</div>
                    <div className="mt-0.5 text-xs" style={{ color: "var(--text-faint)" }}>
                      {s.source} · {s.message_count} messages · started {fmt(s.started_at)}
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
                    background: s.ended_at === null ? "rgba(255,180,84,0.12)" : s.end_reason === "error" || s.end_reason === "failed" ? "rgba(255,92,92,0.12)" : "rgba(61,220,151,0.12)",
                    color: s.ended_at === null ? "var(--amber)" : s.end_reason === "error" || s.end_reason === "failed" ? "var(--red)" : "var(--green)",
                  }}
                >
                  {s.ended_at === null ? "active" : s.end_reason ?? "stopped"}
                </span>
              </div>
              <div className="mt-3 flex items-center gap-3 text-xs" style={{ color: "var(--text-dim)" }}>
                <span>
                  {s.ended_at ? `Stopped ${fmt(s.ended_at)}` : "Still active"}
                </span>
                <Link href={`/chat?resume=${s.id}`} className="ml-auto inline-flex items-center gap-1 font-semibold" style={{ color: "var(--accent)" }}>
                  <RotateCcw className="h-3.5 w-3.5" /> Resume
                </Link>
              </div>
            </div>
          ))}
          {sessions.length === 0 && (
            <div className="card p-8 text-center text-sm" style={{ color: "var(--text-faint)" }}>No sessions found.</div>
          )}
        </div>
      )}
    </div>
  );
}
