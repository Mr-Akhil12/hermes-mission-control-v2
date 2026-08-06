"use client";

import { User, NotebookPen } from "lucide-react";

export default function PersonalPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <User className="h-6 w-6" style={{ color: "var(--accent)" }} /> Personal
        </h1>
        <p className="text-sm" style={{ color: "var(--text-dim)" }}>Memory wiki, Obsidian notes, goals — Phase 2.</p>
      </div>
      <div className="card flex flex-col items-center justify-center gap-3 p-16 text-center">
        <NotebookPen className="h-8 w-8" style={{ color: "var(--text-faint)" }} />
        <p className="text-sm" style={{ color: "var(--text-dim)" }}>
          Hermes memory browser + Obsidian vault access build in Phase 2.
        </p>
      </div>
    </div>
  );
}
