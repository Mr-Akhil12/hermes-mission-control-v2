"use client";

import { useState } from "react";
import { Send, Loader2, CheckCircle2, XCircle } from "lucide-react";

export default function DispatchPage() {
  const [prompt, setPrompt] = useState("");
  const [profile, setProfile] = useState("default");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

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
    } catch (e) {
      setResult({ ok: false, message: String(e) });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Dispatch</h1>
        <p className="text-sm" style={{ color: "var(--text-dim)" }}>Send work to Hermes. Safe tasks run; consequential actions park for approval.</p>
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

      <div className="card p-5">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>Safety boundary</h2>
        <ul className="space-y-2 text-sm" style={{ color: "var(--text-dim)" }}>
          <li>• Emails, purchases, deletes, commits → park in <b>Approvals</b></li>
          <li>• File writes, research, analysis → run immediately</li>
          <li>• You can edit these rules in Settings (Phase 2)</li>
        </ul>
      </div>
    </div>
  );
}
