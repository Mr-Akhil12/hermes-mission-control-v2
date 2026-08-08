"use client";

import { useState, useEffect, useCallback } from "react";
import { Film, Sparkles, Calendar, Kanban, RefreshCw, ExternalLink, ChevronRight } from "lucide-react";

type Card = {
  id: string;
  file: string;
  date: string;
  platform: string;
  title: string;
  status: "idea" | "drafted" | "approved" | "scheduled" | "posted" | "rejected";
  tags: string;
  viral_score: string;
  scheduled_for: string;
  posted_at: string;
  path: string;
};

const COLUMNS: { key: Card["status"]; label: string; color: string }[] = [
  { key: "idea", label: "Idea", color: "var(--text-faint)" },
  { key: "drafted", label: "Drafted", color: "var(--accent-2)" },
  { key: "approved", label: "Approved", color: "var(--accent)" },
  { key: "scheduled", label: "Scheduled", color: "var(--amber)" },
  { key: "posted", label: "Posted", color: "var(--green)" },
  { key: "rejected", label: "Rejected", color: "var(--red)" },
];

const PLATFORM_COLORS: Record<string, string> = {
  linkedin: "#0A66C2",
  x: "#1DA1F2",
  "x/twitter": "#1DA1F2",
  "x-twitter": "#1DA1F2",
  "x-thread": "#1DA1F2",
  "youtube-shorts": "#FF0000",
  "youtube shorts": "#FF0000",
  youtube: "#FF0000",
  blog: "#F7931A",
  tiktok: "#00F2EA",
};

function platformColor(p: string): string {
  const key = p.toLowerCase();
  return PLATFORM_COLORS[key] ?? "var(--accent-2)";
}

function platformLabel(p: string): string {
  const key = p.toLowerCase();
  if (key.includes("linkedin")) return "LinkedIn";
  if (key.includes("x") || key.includes("twitter")) return "X";
  if (key.includes("youtube")) return "YouTube";
  if (key.includes("blog")) return "Blog";
  if (key.includes("tiktok")) return "TikTok";
  return p || "—";
}

export default function StudioPage() {
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"kanban" | "calendar">("kanban");
  const [busyFile, setBusyFile] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/content", { cache: "no-store" });
      const data = await res.json();
      setCards(data?.cards ?? []);
      setError(null);
    } catch (e) {
      setError(`Failed to load content: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  const move = useCallback(
    async (card: Card, status: Card["status"]) => {
      setBusyFile(card.file);
      setError(null);
      try {
        const res = await fetch("/api/content", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file: card.file, status }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error ?? `Update failed (${res.status})`);
        }
        setCards((prev) => prev.map((c) => (c.file === card.file ? { ...c, status } : c)));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyFile(null);
      }
    },
    []
  );

  const filtered = filter === "all" ? cards : cards.filter((c) => c.platform.toLowerCase().includes(filter));
  const platforms = Array.from(new Set(cards.map((c) => c.platform.toLowerCase()).filter(Boolean))).slice(0, 8);

  const byStatus = (status: Card["status"]) => filtered.filter((c) => c.status === status);

  // Calendar: group by date (YYYY-MM-DD), newest first
  const byDate = new Map<string, Card[]>();
  for (const c of filtered) {
    const key = c.date || "unknown";
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key)!.push(c);
  }
  const dates = Array.from(byDate.keys()).sort().reverse().slice(0, 30);

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Film className="h-6 w-6" style={{ color: "var(--accent)" }} />
          <div>
            <h1 className="text-2xl font-bold">Content Studio</h1>
            <p className="text-sm" style={{ color: "var(--text-dim)" }}>
              {cards.length} pieces from the vault — move cards to update the source of truth.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border" style={{ borderColor: "var(--card-border)" }}>
            <button
              onClick={() => setView("kanban")}
              className="flex items-center gap-1.5 rounded-l-lg px-3 py-2 text-sm font-semibold"
              style={{ background: view === "kanban" ? "rgba(124,108,255,0.15)" : "transparent", color: view === "kanban" ? "var(--accent)" : "var(--text-dim)" }}
            >
              <Kanban className="h-4 w-4" /> Board
            </button>
            <button
              onClick={() => setView("calendar")}
              className="flex items-center gap-1.5 rounded-r-lg px-3 py-2 text-sm font-semibold"
              style={{ background: view === "calendar" ? "rgba(124,108,255,0.15)" : "transparent", color: view === "calendar" ? "var(--accent)" : "var(--text-dim)" }}
            >
              <Calendar className="h-4 w-4" /> Calendar
            </button>
          </div>
          <button
            onClick={load}
            className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
            style={{ borderColor: "var(--card-border)", color: "var(--text-dim)" }}
          >
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
        </div>
      </div>

      {platforms.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setFilter("all")}
            className="rounded-full px-3 py-1 text-xs font-semibold"
            style={{ background: filter === "all" ? "rgba(124,108,255,0.15)" : "transparent", color: filter === "all" ? "var(--accent)" : "var(--text-dim)", border: "1px solid var(--card-border)" }}
          >
            All
          </button>
          {platforms.map((p) => (
            <button
              key={p}
              onClick={() => setFilter(p)}
              className="rounded-full px-3 py-1 text-xs font-semibold"
              style={{ background: filter === p ? "rgba(124,108,255,0.15)" : "transparent", color: filter === p ? "var(--accent)" : "var(--text-dim)", border: "1px solid var(--card-border)" }}
            >
              {platformLabel(p)}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="card border px-4 py-3 text-sm" style={{ borderColor: "color-mix(in srgb, var(--red) 40%, transparent)", color: "var(--red)" }}>
          {error}
        </div>
      )}

      {loading ? (
        <div className="card p-8 text-center text-sm" style={{ color: "var(--text-dim)" }}>
          Loading content…
        </div>
      ) : cards.length === 0 ? (
        <div className="card flex flex-col items-center justify-center gap-3 p-16 text-center">
          <Sparkles className="h-8 w-8" style={{ color: "var(--text-faint)" }} />
          <p className="text-sm" style={{ color: "var(--text-dim)" }}>
            No content found in the vault. The studio reads from the Obsidian Content folder.
          </p>
        </div>
      ) : view === "kanban" ? (
        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          {COLUMNS.map((col) => {
            const items = byStatus(col.key);
            return (
              <div key={col.key} className="flex min-h-[300px] flex-col rounded-xl border p-3" style={{ borderColor: "var(--card-border)", background: "color-mix(in srgb, var(--bg) 40%, transparent)" }}>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider" style={{ color: col.color }}>
                    {col.label}
                  </span>
                  <span className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ background: "color-mix(in srgb, var(--bg) 60%, transparent)", color: "var(--text-faint)" }}>
                    {items.length}
                  </span>
                </div>
                <div className="flex-1 space-y-2">
                  {items.slice(0, 30).map((c) => (
                    <div key={c.id} className="card p-3">
                      <div className="flex items-center gap-1.5">
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: platformColor(c.platform) }} />
                        <span className="text-[10px] font-semibold uppercase" style={{ color: platformColor(c.platform) }}>
                          {platformLabel(c.platform)}
                        </span>
                        <span className="ml-auto text-[10px]" style={{ color: "var(--text-faint)" }}>{c.date}</span>
                      </div>
                      <div className="mt-1.5 line-clamp-2 text-xs font-medium leading-snug">{c.title}</div>
                      {c.viral_score && (
                        <div className="mt-1 text-[10px] font-semibold" style={{ color: "var(--amber)" }}>
                          ⚡ {c.viral_score}
                        </div>
                      )}
                      <div className="mt-2 flex items-center gap-1">
                        <select
                          value={c.status}
                          disabled={busyFile === c.file}
                          onChange={(e) => move(c, e.target.value as Card["status"])}
                          className="w-full rounded-md border bg-transparent px-1.5 py-1 text-[10px] font-semibold outline-none disabled:opacity-50"
                          style={{ borderColor: "var(--card-border)", color: "var(--text-dim)" }}
                        >
                          {COLUMNS.map((opt) => (
                            <option key={opt.key} value={opt.key} style={{ color: "var(--text)" }}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  ))}
                  {items.length === 0 && (
                    <div className="rounded-lg border border-dashed p-4 text-center text-[10px]" style={{ borderColor: "var(--card-border)", color: "var(--text-faint)" }}>
                      Empty
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="space-y-4">
          {dates.map((d) => (
            <div key={d} className="card p-4">
              <div className="mb-2 flex items-center gap-2">
                <Calendar className="h-4 w-4" style={{ color: "var(--accent)" }} />
                <span className="text-sm font-bold">{d}</span>
                <span className="text-xs" style={{ color: "var(--text-faint)" }}>{byDate.get(d)!.length} piece(s)</span>
              </div>
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {byDate.get(d)!.map((c) => (
                  <div key={c.id} className="flex items-start gap-2 rounded-lg border p-3" style={{ borderColor: "var(--card-border)" }}>
                    <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: platformColor(c.platform) }} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium">{c.title}</div>
                      <div className="mt-0.5 flex items-center gap-2 text-[10px]" style={{ color: "var(--text-faint)" }}>
                        <span style={{ color: platformColor(c.platform) }}>{platformLabel(c.platform)}</span>
                        <span className="rounded px-1.5 py-0.5 font-semibold uppercase" style={{ background: "color-mix(in srgb, var(--bg) 60%, transparent)", color: "var(--text-dim)" }}>
                          {c.status}
                        </span>
                      </div>
                    </div>
                    <select
                      value={c.status}
                      disabled={busyFile === c.file}
                      onChange={(e) => move(c, e.target.value as Card["status"])}
                      className="rounded-md border bg-transparent px-1.5 py-1 text-[10px] font-semibold outline-none disabled:opacity-50"
                      style={{ borderColor: "var(--card-border)", color: "var(--text-dim)" }}
                    >
                      {COLUMNS.map((opt) => (
                        <option key={opt.key} value={opt.key} style={{ color: "var(--text)" }}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
