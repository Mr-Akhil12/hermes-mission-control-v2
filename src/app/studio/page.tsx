"use client";

import { Film, Sparkles } from "lucide-react";

export default function StudioPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Film className="h-6 w-6" style={{ color: "var(--accent)" }} /> Content Studio
        </h1>
        <p className="text-sm" style={{ color: "var(--text-dim)" }}>Pipeline board, viral scores, calendar — Phase 2.</p>
      </div>
      <div className="card flex flex-col items-center justify-center gap-3 p-16 text-center">
        <Sparkles className="h-8 w-8" style={{ color: "var(--text-faint)" }} />
        <p className="text-sm" style={{ color: "var(--text-dim)" }}>
          The studio kanban (ideas → approved → scheduled → posted) builds in Phase 2 with the content pipeline crons.
        </p>
      </div>
    </div>
  );
}
