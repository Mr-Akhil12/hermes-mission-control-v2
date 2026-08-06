"use client";

import { Wrench, Search, ExternalLink } from "lucide-react";
import { useState } from "react";

export default function DevPage() {
  const [query, setQuery] = useState("");

  const projects = [
    { name: "agenticbiz", repo: "Mr-Akhil12/agenticbiz", url: "https://agenticbiz.co.za" },
    { name: "akhil-portfolio", repo: "Mr-Akhil12/akhil-portfolio", url: "https://akhil-devs-portfolio.vercel.app" },
    { name: "akhils-trading", repo: "Mr-Akhil12/akhils-trading", url: "https://akhils-trading.vercel.app" },
    { name: "hyperframes", repo: "Mr-Akhil12/hyperframes", url: "https://github.com/Mr-Akhil12/hyperframes" },
    { name: "hermes-dump", repo: "Mr-Akhil12/hermes-dump", url: "https://github.com/Mr-Akhil12/hermes-dump" },
  ];

  const artifacts = [
    { title: "Hermes OS v2 buildspec", kind: "plan", repo: "hermes-dump", url: "https://github.com/Mr-Akhil12/hermes-dump/blob/main/2026-08-06/hermes-os-v2-buildspec.md" },
    { title: "Hermes OS v2 plan HTML", kind: "html", repo: "hermes-dump", url: "https://github.com/Mr-Akhil12/hermes-dump/blob/main/2026-08-06/hermes-os-v2-plan.html" },
    { title: "ai-stack-2026 video", kind: "video", repo: "hyperframes", url: "https://github.com/Mr-Akhil12/hyperframes" },
  ];

  const filtered = artifacts.filter((a) =>
    query.trim() ? a.title.toLowerCase().includes(query.toLowerCase()) : true
  );

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Wrench className="h-6 w-6" style={{ color: "var(--accent)" }} /> Development
        </h1>
        <p className="text-sm" style={{ color: "var(--text-dim)" }}>Projects, deploys, and every artifact Hermes produced — as links, not local paths.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {projects.map((p) => (
          <a key={p.name} href={p.url} target="_blank" rel="noopener noreferrer" className="card card-hover p-4">
            <div className="flex items-center justify-between">
              <span className="font-semibold">{p.name}</span>
              <ExternalLink className="h-3.5 w-3.5" style={{ color: "var(--text-faint)" }} />
            </div>
            <div className="mt-1 font-mono text-[11px]" style={{ color: "var(--text-faint)" }}>{p.repo}</div>
          </a>
        ))}
      </div>

      <section className="card p-5">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
          <Search className="h-4 w-4" /> Artifact search
        </h2>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search everything Hermes produced…"
          className="mb-4 w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
          style={{ borderColor: "var(--card-border)", color: "var(--text)" }}
        />
        <ul className="space-y-2 text-sm">
          {filtered.map((a) => (
            <li key={a.title}>
              <a href={a.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 hover:underline" style={{ color: "var(--accent-2)" }}>
                <span className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase" style={{ background: "rgba(124,108,255,0.12)", color: "var(--accent)" }}>
                  {a.kind}
                </span>
                {a.title}
                <ExternalLink className="h-3 w-3" />
              </a>
            </li>
          ))}
          {filtered.length === 0 && <li style={{ color: "var(--text-faint)" }}>No artifacts match "{query}".</li>}
        </ul>
      </section>
    </div>
  );
}
