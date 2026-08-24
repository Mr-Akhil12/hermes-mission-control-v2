"use client";

import { useEffect, useMemo, useState } from "react";
import { Clock, ChevronDown, ChevronUp, Brain, CheckCircle2, XCircle, FileText, Loader2, Search, Send } from "lucide-react";
import { fmtSAST, fmtSASTSec } from "@/lib/time";
import { humanizeCron, humanizeDeliver } from "@/lib/cron";

type CronJob = {
  job_id: string;
  id?: string;
  name: string;
  schedule: string | { kind?: string; expr?: string; display?: string };
  last_status: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  state: string;
  no_agent: boolean;
  script: string | null;
  deliver?: string | null;
};

type Run = {
  id?: string;
  job_id: string;
  status: string;
  claimed_at: string;
  started_at?: string | null;
  finished_at: string | null;
  error: string | null;
};

type Thinking = {
  session_id: string;
  prompt: string;
  messages: { role: string; content: string }[];
};

function outputFileTimestamp(filename: string): number | null {
  const match = filename.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})\.md$/);
  if (!match) return null;
  const timestamp = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}+02:00`);
  return Number.isNaN(timestamp) ? null : Math.floor(timestamp / 1000);
}

function isSilentOutput(content: string): boolean {
  const value = content.trim();
  return (
    value === "" ||
    /^(?:status:\s*)?(?:silent(?:\s*\(empty output\))?|no output(?:\s*\(silent run\))?|empty output)\s*[.!]?$/i.test(value)
  );
}

export default function CronsPage() {
  const [crons, setCrons] = useState<CronJob[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [thinking, setThinking] = useState<Thinking | null>(null);
  const [thinkingFor, setThinkingFor] = useState<string | null>(null);
  const [thinkingLoading, setThinkingLoading] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const [outputFor, setOutputFor] = useState<string | null>(null);
  const [outputLoading, setOutputLoading] = useState(false);

  useEffect(() => {
    Promise.all([fetch("/api/crons").then((r) => r.json()), fetch("/api/runs").then((r) => r.json())])
      .then(([c, r]) => {
        setCrons(c.jobs ?? []);
        setRuns(r.runs ?? []);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  // Filter by cron name / id / script — case-insensitive substring.
  const filteredCrons = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return crons;
    return crons.filter((c) => {
      const cronId = c.job_id ?? c.id ?? "";
      return (
        c.name.toLowerCase().includes(q) ||
        cronId.toLowerCase().includes(q) ||
        (c.script ?? "").toLowerCase().includes(q)
      );
    });
  }, [crons, filter]);

  // History accordion: only the last 3 runs per job.
  const runsFor = (jobId: string) => runs.filter((r) => r.job_id === jobId).slice(0, 3);

  const loadThinking = async (jobId: string, run?: Run) => {
    setThinkingLoading(true);
    setThinkingFor(jobId);
    setThinking(null);
    try {
      const params = new URLSearchParams();
      params.set("job", jobId);
      if (run?.id) params.set("execution", run.id);
      const res = await fetch(`/api/cron-thinking?${params.toString()}`);
      const data = await res.json();
      if (data.session_id) {
        setThinking(data);
      } else {
        setThinking(null);
        setThinkingFor(null);
      }
    } catch {
      setThinking(null);
      setThinkingFor(null);
    } finally {
      setThinkingLoading(false);
    }
  };

  const loadOutput = async (jobId: string, run: Run) => {
    setOutputLoading(true);
    setOutputFor(jobId);
    setOutput(null);
    try {
      const listRes = await fetch(`/api/cron-output?job=${encodeURIComponent(jobId)}`);
      const listData = await listRes.json();
      if (!listRes.ok) throw new Error(listData.error || "could not list cron output");

      const files: string[] = Array.isArray(listData.files)
        ? listData.files.filter((file: unknown): file is string => typeof file === "string")
        : [];
      const runTimestamp = Math.floor(Date.parse(run.claimed_at) / 1000);
      const filename =
        files.find((file) => outputFileTimestamp(file) === runTimestamp) ?? files[0];
      if (!filename) throw new Error("no cron output files found");

      const params = new URLSearchParams({ job: jobId, file: filename });
      const outputRes = await fetch(`/api/cron-output?${params.toString()}`);
      const outputData = await outputRes.json();
      if (!outputRes.ok) throw new Error(outputData.error || "could not load cron output");
      setOutput(typeof outputData.content === "string" ? outputData.content : "");
    } catch (e) {
      setOutput(`Output unavailable: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setOutputLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin" style={{ color: "var(--accent)" }} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Cron Monitor</h1>
        <p className="text-sm" style={{ color: "var(--text-dim)" }}>
          Run history, agent thinking, and output links for every scheduled job. Times are always SAST.
        </p>
      </div>

      {error && (
        <div className="card p-4 text-sm" style={{ color: "var(--red)" }}>Could not load: {error}</div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="card p-4">
          <div className="text-2xl font-bold" style={{ color: "var(--accent)" }}>{crons.length}</div>
          <div className="text-xs" style={{ color: "var(--text-faint)" }}>Total</div>
        </div>
        <div className="card p-4">
          <div className="text-2xl font-bold" style={{ color: "var(--green)" }}>{crons.filter((c) => c.last_status === "ok").length}</div>
          <div className="text-xs" style={{ color: "var(--text-faint)" }}>Healthy</div>
        </div>
        <div className="card p-4">
          <div className="text-2xl font-bold" style={{ color: "var(--red)" }}>{crons.filter((c) => c.last_status === "error").length}</div>
          <div className="text-xs" style={{ color: "var(--text-faint)" }}>Failed</div>
        </div>
        <div className="card p-4">
          <div className="text-2xl font-bold" style={{ color: "var(--amber)" }}>{runs.length}</div>
          <div className="text-xs" style={{ color: "var(--text-faint)" }}>Runs (24h)</div>
        </div>
      </div>

      {/* Filter box */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" style={{ color: "var(--text-faint)" }} />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter crons by name, id, or script…"
          className="w-full rounded-lg border bg-transparent py-2.5 pl-9 pr-3 text-sm outline-none"
          style={{ borderColor: "var(--card-border)", color: "var(--text)" }}
        />
      </div>

      <div className="space-y-3">
        {filteredCrons.length === 0 && (
          <div className="card p-6 text-center text-sm" style={{ color: "var(--text-faint)" }}>
            No crons match “{filter}”.
          </div>
        )}
        {filteredCrons.map((cron) => {
          const cronId = cron.job_id ?? cron.id ?? "unknown";
          const jobRuns = runsFor(cronId);
          const isOpen = expanded === cronId;
          const lastFailed = jobRuns.some((r) => r.status === "failed");

          return (
            <div key={cronId} className="card overflow-hidden" style={lastFailed ? { borderColor: "color-mix(in srgb, var(--red) 40%, transparent)" } : undefined}>
              <button className="flex w-full items-center gap-3 p-4 text-left" onClick={() => setExpanded(isOpen ? null : cronId)}>
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: lastFailed ? "var(--red)" : cron.last_status === "ok" ? "var(--green)" : "var(--amber)" }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{cron.name}</span>
                    {cron.no_agent && (
                      <span className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase" style={{ background: "rgba(77,159,255,0.12)", color: "var(--accent-2)" }}>
                        script
                      </span>
                    )}
                    {!cron.no_agent && (
                      <span className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase" style={{ background: "rgba(124,108,255,0.12)", color: "var(--accent)" }}>
                        agent
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" style={{ color: "var(--text-faint)" }}>
                    <span>{humanizeCron(cron.schedule)}</span>
                    <span>· last {fmtSAST(cron.last_run_at)}</span>
                    <span>· next {fmtSAST(cron.next_run_at)}</span>
                    <span className="flex items-center gap-1" style={{ color: "var(--accent-2)" }}>
                      <Send className="h-3 w-3" />
                      {humanizeDeliver(cron.deliver).label}
                    </span>
                  </div>
                </div>
                {isOpen ? <ChevronUp className="h-4 w-4 shrink-0" style={{ color: "var(--text-faint)" }} /> : <ChevronDown className="h-4 w-4 shrink-0" style={{ color: "var(--text-faint)" }} />}
              </button>

              {isOpen && (
                <div className="border-t p-4" style={{ borderColor: "var(--card-border)" }}>
                  {/* Run history — last 3 runs only */}
                  <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
                    <Clock className="h-3.5 w-3.5" /> Last 3 runs
                  </h3>
                  {jobRuns.length === 0 ? (
                    <div className="text-xs" style={{ color: "var(--text-faint)" }}>No runs in the last 25h.</div>
                  ) : (
                    <div className="space-y-1.5">
                      {jobRuns.map((run, i) => (
                        <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-xs" style={{ background: "color-mix(in srgb, var(--bg) 60%, transparent)" }}>
                          {run.status === "completed" || run.status === "ok" ? (
                            <CheckCircle2 className="h-3.5 w-3.5" style={{ color: "var(--green)" }} />
                          ) : run.status === "failed" ? (
                            <XCircle className="h-3.5 w-3.5" style={{ color: "var(--red)" }} />
                          ) : (
                            <Clock className="h-3.5 w-3.5" style={{ color: "var(--amber)" }} />
                          )}
                          <span style={{ color: "var(--text-dim)" }}>{fmtSASTSec(run.claimed_at)}</span>
                          <span className="font-medium">{run.status}</span>
                          {run.error && <span className="truncate font-mono" style={{ color: "var(--red)" }} title={run.error}>{run.error.slice(0, 80)}</span>}
                          <div className="ml-auto flex items-center gap-1.5">
                            {!cron.no_agent && (
                              <button
                                onClick={() => loadThinking(cronId, run)}
                                className="flex items-center gap-1 rounded-md px-2 py-1 font-semibold"
                                style={{ color: "var(--accent)", background: "rgba(124,108,255,0.10)" }}
                              >
                                <Brain className="h-3 w-3" /> Thinking
                              </button>
                            )}
                            <button
                              onClick={() => loadOutput(cronId, run)}
                              className="flex items-center gap-1 rounded-md px-2 py-1 font-semibold"
                              style={{ color: "var(--accent-2)", background: "rgba(77,159,255,0.10)" }}
                            >
                              <FileText className="h-3 w-3" /> Output
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Thinking viewer */}
                  {thinking && thinkingFor === cronId && (
                    <div className="mt-4 rounded-lg border p-4" style={{ borderColor: "var(--card-border)" }}>
                      <div className="mb-2 flex items-center justify-between">
                        <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--accent)" }}>
                          <Brain className="h-3.5 w-3.5" /> Agent thinking — {thinking.session_id.slice(0, 24)}…
                        </h4>
                        <button onClick={() => setThinking(null)} className="text-xs" style={{ color: "var(--text-faint)" }}>close</button>
                      </div>
                      <div className="max-h-80 space-y-2 overflow-y-auto text-xs">
                        {thinking.messages.map((m, i) => (
                          <div key={i} className="rounded-lg p-2" style={{ background: m.role === "assistant" ? "rgba(124,108,255,0.07)" : "color-mix(in srgb, var(--bg) 50%, transparent)" }}>
                            <span className="font-bold uppercase" style={{ color: m.role === "assistant" ? "var(--accent)" : "var(--accent-2)" }}>{m.role}</span>
                            <pre className="mt-1 whitespace-pre-wrap font-sans" style={{ color: "var(--text-dim)" }}>{m.content.slice(0, 1200)}</pre>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {thinkingLoading && thinkingFor === cronId && (
                    <div className="mt-4 flex items-center gap-2 text-xs" style={{ color: "var(--text-faint)" }}>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading thinking…
                    </div>
                  )}

                  {/* Cron output viewer */}
                  {output !== null && outputFor === cronId && (
                    <div className="mt-4 rounded-lg border p-4" style={{ borderColor: "var(--card-border)" }}>
                      <div className="mb-2 flex items-center justify-between">
                        <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--accent-2)" }}>
                          <FileText className="h-3.5 w-3.5" /> Cron output
                        </h4>
                        <button
                          onClick={() => {
                            setOutput(null);
                            setOutputFor(null);
                          }}
                          className="text-xs"
                          style={{ color: "var(--text-faint)" }}
                        >
                          close
                        </button>
                      </div>
                      {isSilentOutput(output) ? (
                        <div className="text-xs" style={{ color: "var(--text-faint)" }}>No output (silent run)</div>
                      ) : (
                        <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs" style={{ color: "var(--text-dim)" }}>
                          {output}
                        </pre>
                      )}
                    </div>
                  )}

                  {outputLoading && outputFor === cronId && (
                    <div className="mt-4 flex items-center gap-2 text-xs" style={{ color: "var(--text-faint)" }}>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading output…
                    </div>
                  )}

                  {/* Footer meta */}
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]" style={{ color: "var(--text-faint)" }}>
                    <span>ID: {cronId}</span>
                    {cron.script && <span>· script: {cron.script}</span>}
                    <span className="flex items-center gap-1">
                      <Send className="h-3 w-3" /> {humanizeDeliver(cron.deliver).label}
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
