"use client";

import { GitCommit, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { fmtSASTRelative } from "@/lib/time";

export type Project = {
  name: string;
  source: "vercel" | "github" | "both";
  vercelId: string | null;
  framework: string | null;
  repo: string | null;
  private: boolean | null;
  description: string | null;
  defaultBranch: string | null;
  pushedAt: string | null;
  updatedAt: string | null;
  url: string | null;
};

type Commit = {
  sha: string;
  message: string;
  author: string;
  date: string | null;
};

type CommitFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
};

type CommitDetail = Commit & { files: CommitFile[] };

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function commitTitle(message: string): string {
  return message.split("\n", 1)[0] || "Untitled commit";
}

function statusColor(status: string): string {
  switch (status) {
    case "added":
      return "var(--green)";
    case "removed":
      return "var(--red)";
    case "renamed":
      return "var(--amber)";
    default:
      return "var(--accent)";
  }
}

function PatchLine({ line }: { line: string }) {
  let background = "transparent";
  let color = "var(--text-dim)";

  if (line.startsWith("@@")) {
    background = "color-mix(in srgb, var(--accent) 12%, transparent)";
    color = "color-mix(in srgb, var(--accent) 78%, var(--text))";
  } else if (line.startsWith("+") && !line.startsWith("+++")) {
    background = "color-mix(in srgb, var(--green) 13%, transparent)";
    color = "var(--green)";
  } else if (line.startsWith("-") && !line.startsWith("---")) {
    background = "color-mix(in srgb, var(--red) 13%, transparent)";
    color = "var(--red)";
  }

  return (
    <span className="block min-h-5 px-3" style={{ background, color }}>
      {line || "\u00a0"}
    </span>
  );
}

function FileDiff({ file }: { file: CommitFile }) {
  const color = statusColor(file.status);

  return (
    <section className="overflow-hidden rounded-lg border" style={{ borderColor: "var(--card-border)" }}>
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2"
        style={{
          borderColor: "var(--card-border)",
          background: "color-mix(in srgb, var(--bg) 58%, transparent)",
        }}
      >
        <span className="min-w-0 flex-1 break-all font-mono text-xs font-semibold">
          {file.filename}
        </span>
        <span className="shrink-0 font-mono text-[11px]">
          <span style={{ color: "var(--green)" }}>+{file.additions}</span>{" "}
          <span style={{ color: "var(--red)" }}>−{file.deletions}</span>
        </span>
        <span
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
          style={{
            background: `color-mix(in srgb, ${color} 14%, transparent)`,
            color,
          }}
        >
          {file.status}
        </span>
      </div>

      {file.patch ? (
        <div className="overflow-x-auto">
          <pre className="min-w-max py-1 font-mono text-[11px] leading-5">
            {file.patch.split("\n").map((line, index) => (
              <PatchLine key={`${index}-${line}`} line={line} />
            ))}
          </pre>
        </div>
      ) : (
        <p className="px-3 py-4 text-xs" style={{ color: "var(--text-faint)" }}>
          Unified patch unavailable (the file may be binary or too large).
        </p>
      )}
    </section>
  );
}

export default function DevCommitsTab({ project }: { project: Project }) {
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/dev/projects/${encodeURIComponent(project.name)}/commits`, { cache: "no-store" })
      .then((response) =>
        response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))
      )
      .then((data) => {
        if (cancelled) return;
        setCommits(data.commits ?? []);
        setBranch(data.branch ?? null);
      })
      .catch((fetchError) => {
        if (!cancelled) {
          setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [project.name]);

  useEffect(() => {
    return () => detailRequest.current?.abort();
  }, []);

  async function showCommit(sha: string) {
    detailRequest.current?.abort();
    const controller = new AbortController();
    detailRequest.current = controller;

    setSelectedSha(sha);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);

    try {
      const response = await fetch(
        `/api/dev/projects/${encodeURIComponent(project.name)}/commits/${encodeURIComponent(sha)}`,
        { cache: "no-store", signal: controller.signal }
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      if (!controller.signal.aborted) setDetail(data);
    } catch (fetchError) {
      if (!controller.signal.aborted) {
        setDetailError(fetchError instanceof Error ? fetchError.message : String(fetchError));
      }
    } finally {
      if (!controller.signal.aborted) setDetailLoading(false);
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2
            className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider"
            style={{ color: "var(--text-faint)" }}
          >
            <GitCommit className="h-4 w-4" /> Recent Commits
          </h2>
          {branch && (
            <span className="font-mono text-xs" style={{ color: "var(--text-dim)" }}>
              {branch}
            </span>
          )}
        </div>

        {error ? (
          <p className="text-sm" style={{ color: "var(--red)" }}>
            Failed to load commits: {error}
          </p>
        ) : !commits ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="skeleton h-10 w-full" />
            ))}
          </div>
        ) : commits.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-faint)" }}>
            No commits found.
          </p>
        ) : (
          <ul className="space-y-2">
            {commits.map((commit) => {
              const selected = selectedSha === commit.sha;
              const filesChanged = selected && detail?.sha === commit.sha ? detail.files.length : null;

              return (
                <li key={commit.sha}>
                  <button
                    type="button"
                    onClick={() => void showCommit(commit.sha)}
                    aria-expanded={selected}
                    className="flex w-full items-start gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/5"
                    style={
                      selected
                        ? { background: "color-mix(in srgb, var(--accent) 9%, transparent)" }
                        : undefined
                    }
                  >
                    <span
                      className="mt-0.5 shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]"
                      style={{
                        background: "color-mix(in srgb, var(--accent) 14%, transparent)",
                        color: "var(--accent)",
                      }}
                    >
                      {shortSha(commit.sha)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{commitTitle(commit.message)}</span>
                      <span className="block text-[11px]" style={{ color: "var(--text-faint)" }}>
                        {commit.author} · {fmtSASTRelative(commit.date)}
                        {filesChanged !== null && ` · Files changed (${filesChanged})`}
                        {selected && detailLoading && " · Loading diff…"}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {(selectedSha || detailError) && (
        <div className="border-t p-5" style={{ borderColor: "var(--card-border)" }}>
          {detailLoading ? (
            <div
              className="flex items-center justify-center gap-2 py-8 text-sm"
              style={{ color: "var(--text-dim)" }}
            >
              <Loader2 className="h-4 w-4 animate-spin" style={{ color: "var(--accent)" }} />
              Loading commit diff…
            </div>
          ) : detailError ? (
            <p className="text-sm" style={{ color: "var(--red)" }}>
              Failed to load commit diff: {detailError}
            </p>
          ) : detail ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="break-words text-sm font-semibold">{commitTitle(detail.message)}</h3>
                  <p className="mt-0.5 font-mono text-[11px]" style={{ color: "var(--text-faint)" }}>
                    {detail.sha}
                  </p>
                </div>
                <span className="shrink-0 text-xs font-semibold" style={{ color: "var(--text-dim)" }}>
                  Files changed ({detail.files.length})
                </span>
              </div>

              {detail.files.length > 0 ? (
                <div className="space-y-3">
                  {detail.files.map((file) => (
                    <FileDiff key={file.filename} file={file} />
                  ))}
                </div>
              ) : (
                <p className="text-sm" style={{ color: "var(--text-faint)" }}>
                  No changed files were returned for this commit.
                </p>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
