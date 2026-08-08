"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, ArrowRight, Send, NotebookPen, CalendarDays, Activity } from "lucide-react";

type CronJob = {
  job_id?: string;
  id?: string;
  name: string;
  schedule: string | { kind?: string; expr?: string; display?: string };
  last_status: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  state: string;
};

type Brief = {
  id: string;
  date: string;
  content: {
    attention: { type: string; name?: string; id?: string }[];
    shipped: unknown[];
    next_actions: unknown[];
    one_thing: string | null;
  };
  created_at: string;
};

export default function Home() {
  const [crons, setCrons] = useState<CronJob[]>([]);
  const [briefs, setBriefs] = useState<Brief[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/crons").then((r) => r.json()),
      fetch("/api/briefs").then((r) => r.json()),
    ])
      .then(([c, b]) => {
        setCrons(c.jobs ?? []);
        setBriefs(b.briefs ?? []);
      })
      .catch((e) => setLoadError(String(e)));
  }, []);

  const cronId = (c: CronJob) => c.job_id ?? c.id ?? "unknown";

  // REAL failure signal: last_status === "error" from jobs.json (verified:
  // executions.db uses completed/running — not failed — so run-status counts
  // always read 0 failures. last_status is the true source.)
  const failed = crons.filter((c) => c.last_status === "error");
  const healthy = crons.filter((c) => c.last_status === "ok");
  const quiet = crons.filter((c) => c.last_status !== "error" && c.last_status !== "ok");

  const now = new Date();
  const dateStr = now.toLocaleDateString("en-ZA", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const timeStr = now.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Johannesburg" });

  const today = now.toISOString().slice(0, 10);
  const todayBrief = briefs.find((b) => b.date === today) ?? briefs[0];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {/* Hero */}
      <div className="card p-6">
        <div className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--accent-2)" }}>
          {dateStr} · {timeStr} SAST
        </div>
        <h1 className="mt-2 text-2xl font-bold md:text-3xl">Good morning, Akhil.</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--text-dim)" }}>
          {failed.length > 0
            ? `${failed.length} cron${failed.length > 1 ? "s" : ""} need attention.`
            : "All systems nominal. Nothing needs you right now."}
        </p>
      </div>

      {loadError && (
        <div className="card border-red-500/40 p-4 text-sm" style={{ color: "var(--red)" }}>
          Could not load live state: {loadError}
        </div>
      )}

      {/* One thing — from the daily brief */}
      {todayBrief?.content?.one_thing && (
        <section className="card p-5" style={{ borderColor: "color-mix(in srgb, var(--amber) 35%, transparent)" }}>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--amber)" }}>
            <Activity className="h-4 w-4" /> One thing · {todayBrief.date}
          </div>
          <div className="mt-1.5 text-lg font-bold">{todayBrief.content.one_thing}</div>
          {todayBrief.content.attention.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {todayBrief.content.attention.slice(0, 6).map((a, i) => (
                <span key={i} className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase" style={{ background: "color-mix(in srgb, var(--red) 12%, transparent)", color: "var(--red)" }}>
                  {a.type.replace(/_/g, " ")} {a.name ? `· ${a.name}` : ""}
                </span>
              ))}
            </div>
          )}
          <Link href="/crons" className="mt-3 inline-flex items-center gap-1 text-xs font-semibold" style={{ color: "var(--accent)" }}>
            Investigate <ArrowRight className="h-3 w-3" />
          </Link>
        </section>
      )}

      {/* Attention queue */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
          <AlertTriangle className="h-4 w-4" /> Needs attention
        </h2>
        {failed.length === 0 ? (
          <div className="card flex items-center gap-3 p-4">
            <CheckCircle2 className="h-5 w-5" style={{ color: "var(--green)" }} />
            <span className="text-sm" style={{ color: "var(--text-dim)" }}>No failed crons right now.</span>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {failed.slice(0, 6).map((c) => (
              <div key={cronId(c)} className="card card-hover p-4" style={{ borderColor: "color-mix(in srgb, var(--red) 40%, transparent)" }}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold">{c.name}</div>
                    <div className="text-xs" style={{ color: "var(--text-faint)" }}>
                      last run {c.last_run_at ? new Date(c.last_run_at).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" }) : "—"}
                    </div>
                  </div>
                  <span className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase" style={{ background: "color-mix(in srgb, var(--red) 15%, transparent)", color: "var(--red)" }}>
                    failed
                  </span>
                </div>
                <Link href="/crons" className="mt-3 inline-flex items-center gap-1 text-xs font-semibold" style={{ color: "var(--accent)" }}>
                  Investigate <ArrowRight className="h-3 w-3" />
                </Link>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Real system status — counts from jobs.json last_status */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
          System status
        </h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="card p-4">
            <div className="text-2xl font-bold" style={{ color: "var(--accent)" }}>{crons.length}</div>
            <div className="text-xs" style={{ color: "var(--text-faint)" }}>Total crons</div>
          </div>
          <div className="card p-4">
            <div className="text-2xl font-bold" style={{ color: "var(--green)" }}>{healthy.length}</div>
            <div className="text-xs" style={{ color: "var(--text-faint)" }}>Healthy</div>
          </div>
          <div className="card p-4">
            <div className="text-2xl font-bold" style={{ color: "var(--red)" }}>{failed.length}</div>
            <div className="text-xs" style={{ color: "var(--text-faint)" }}>Failed</div>
          </div>
          <div className="card p-4">
            <div className="text-2xl font-bold" style={{ color: "var(--amber)" }}>{quiet.length}</div>
            <div className="text-xs" style={{ color: "var(--text-faint)" }}>Quiet/other</div>
          </div>
        </div>
      </section>

      {/* Brief history */}
      {briefs.length > 0 && (
        <section className="card p-5">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
            <CalendarDays className="h-4 w-4" /> Daily brief history
          </h2>
          <ul className="space-y-2">
            {briefs.map((b) => (
              <li key={b.id} className="flex items-start gap-2 text-sm">
                <NotebookPen className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: "var(--accent-2)" }} />
                <div className="min-w-0 flex-1">
                  <span className="font-semibold">{b.date}</span>
                  {b.content?.one_thing && <span style={{ color: "var(--text-dim)" }}> — {b.content.one_thing}</span>}
                </div>
                <span className="shrink-0 text-[10px]" style={{ color: "var(--text-faint)" }}>
                  {b.content?.attention?.length ?? 0} attention
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Dispatch CTA */}
      <section className="card flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-bold">Send work to Hermes</h2>
          <p className="text-sm" style={{ color: "var(--text-dim)" }}>Quick dispatch from anywhere — ⌘K on desktop, or the Dispatch page.</p>
        </div>
        <Link href="/dispatch" className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white" style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}>
          <Send className="h-4 w-4" /> Dispatch
        </Link>
      </section>
    </div>
  );
}
