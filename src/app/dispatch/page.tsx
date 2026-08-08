"use client";

import { useState, useEffect, useCallback } from "react";
import { Send, Loader2, CheckCircle2, XCircle, ListChecks, Clock, AlertTriangle } from "lucide-react";

type Task = {
  id: string;
  prompt: string;
  profile: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  result: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export default function DispatchPage() {
  const [prompt, setPrompt] = useState("");
  const [profile, setProfile] = useState("default");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);

  const loadQueue = useCallback(async () => {
    try {
      const res = await fetch("/api/dispatch/queue", { cache: "no-store" });
      const data = await res.json();
      setTasks(data?.tasks ?? []);
    } catch {
      // queue read failure is non-fatal
    }
  }, []);

  useEffect(() => {
    loadQueue();
    const t = setInterval(loadQueue, 15000);
    return () => clearInterval(t);
  }, [loadQueue]);

  const dispatch = async () => {
    if (!prompt.trim()) return;
    setSending(true);
    setResult(null);
    try {
      const res = await fetch("/api/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: prompt.trim(), profile }),
      });
      const data = await res.json();
      setResult({ ok: res.ok, message: data.message ?? data.error ?? "Dispatched." });
      if (res.ok) setPrompt("");
      loadQueue();
    } catch (e) {
      setResult({ ok: false, message: String(e) });
    } finally {
      setSending(false);
    }
  };

  const statusStyle = (s: Task["status"]) => {
    switch (s) {
      case "done": return { color: "var(--green)" };
      case "failed": return { color: "var(--red)" };
      case "running": return { color: "var(--accent)" };
      default: return { color: "var(--amber)" };
    }
  };
  const statusIcon = (s: Task["status"]) => {
    switch (s) {
      case "done": return <CheckCircle2 className="h-3.5 w-3.5" />;
      case "failed": return <XCircle className="h-3.5 w-3.5" />;
      case "running": return <Loader2 className="h-3.5 w-3.5 animate-spin" />;
      default: return <Clock className="h-3.5 w-3.5" />;
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Dispatch</h1>
        <p className="text-sm" style={{ color: "var(--text-dim)" }}>Send work to Hermes. Safe tasks run; consequential actions park for approval. If Hermes is unreachable, tasks queue and run when it's back.</p>
      </div>

      <div className="card p-5">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) dispatch(); }}
          rows={4}
          placeholder="What should Hermes do? (⌘/Ctrl+Enter to send)"
          className="w-full resize-none rounded-lg border bg-transparent p-3 text-sm outline-none"
          style={{ borderColor: "var(--card-border)", color: "var(--text)" }}
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <select
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            className="rounded-lg border bg-transparent px-3 py-2 text-sm"
            style={{ borderColor: "var(--card-border)", color: "var(--text)" }}
          >
            <option value="default">default</option>
            <option value="content">content</option>
            <option value="trading">trading</option>
            <option value="dev">dev</option>
          </select>
          <button
            onClick={dispatch}
            disabled={sending || !prompt.trim()}
            className="ml-auto flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {sending ? "Dispatching…" : "Dispatch"}
          </button>
        </div>

        {result && (
          <div className={`mt-4 flex items-start gap-2 rounded-lg p-3 text-sm ${result.ok ? "" : ""}`}
            style={{ background: result.ok ? "rgba(61,220,151,0.10)" : "rgba(255,92,92,0.10)", color: result.ok ? "var(--green)" : "var(--red)" }}>
            {result.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
            <span>{result.message}</span>
          </div>
        )}
      </div>

      {tasks.length > 0 && (
        <div className="card p-5">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
            <ListChecks className="h-4 w-4" /> Task queue ({tasks.length})
          </h2>
          <ul className="space-y-2">
            {tasks.slice(0, 10).map((t) => (
              <li key={t.id} className="rounded-lg border px-3 py-2" style={{ borderColor: "var(--card-border)" }}>
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 shrink-0" style={statusStyle(t.status)}>{statusIcon(t.status)}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{t.prompt}</div>
                    <div className="text-[10px]" style={{ color: "var(--text-faint)" }}>
                      {t.profile} · {t.status} · {t.created_at ? new Date(t.created_at).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" }) : ""}
                    </div>
                    {t.error && (
                      <div className="mt-1 flex items-start gap-1 text-[11px]" style={{ color: "var(--red)" }}>
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {t.error}
                      </div>
                    )}
                    {t.result && (
                      <div className="mt-1 line-clamp-2 text-[11px]" style={{ color: "var(--text-dim)" }}>{t.result}</div>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card p-5">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>Safety boundary</h2>
        <ul className="space-y-2 text-sm" style={{ color: "var(--text-dim)" }}>
          <li>• Emails, purchases, deletes, commits → park in <b>Approvals</b> in real time</li>
          <li>• File writes, research, analysis → run immediately</li>
          <li>• Approve once, always allow, or deny from the Approvals screen</li>
          <li>• Tunnel down? Tasks queue in Turso and run when the bridge reconnects</li>
        </ul>
      </div>
    </div>
  );
}
