"use client";

import {
  Wrench,
  Search,
  ArrowLeft,
  Folder,
  GitCommit,
  Rocket,
  MessageSquare,
  ExternalLink,
  ChevronRight,
  Lock,
  Globe,
  RefreshCw,
  Boxes,
  GitBranch,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtSASTRelative } from "@/lib/time";
import DevFilesTab from "@/components/dev/DevFilesTab";
import DevCommitsTab from "@/components/dev/DevCommitsTab";
import DevChatTab from "@/components/dev/DevChatTab";

// ── Types ────────────────────────────────────────────────────────────────

type Project = {
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

type VercelDeploy = { uid: string; url: string; readyState: string; target: string; created: string | null };
type GhDeploy = { id: number; ref: string; environment: string; created_at: string | null };
type Artifact = { title: string; kind: string; url: string; repo?: string };

type Tab = "files" | "commits" | "deployments" | "chat";

// ── Helpers ──────────────────────────────────────────────────────────────

function titleCase(name: string): string {
  return name
    .split(/[-_]/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function readyStateColor(state: string): string {
  switch (state) {
    case "READY":
      return "var(--green)";
    case "ERROR":
      return "var(--red)";
    case "BUILDING":
    case "QUEUED":
    case "INITIALIZING":
      return "var(--amber)";
    default:
      return "var(--text-faint)";
  }
}

// ── Small presentational components ─────────────────────────────────────

function Badge({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
      style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color }}
    >
      {children}
    </span>
  );
}

function SkeletonCard() {
  return (
    <div className="card p-4">
      <div className="skeleton h-4 w-2/3" />
      <div className="skeleton mt-3 h-3 w-full" />
      <div className="skeleton mt-2 h-3 w-1/2" />
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────────────

export default function DevPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Project | null>(null);

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/dev/projects", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setProjects(data.projects ?? []);
      setWarnings(data.warnings ?? []);
    } catch (e) {
      setProjectsError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/dev/projects", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (cancelled) return;
        setProjects(data.projects ?? []);
        setWarnings(data.warnings ?? []);
      })
      .catch((e) => {
        if (!cancelled) setProjectsError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!projects) return [];
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q) ||
        (p.framework ?? "").toLowerCase().includes(q)
    );
  }, [projects, query]);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {selected ? (
        <Workspace project={selected} onBack={() => setSelected(null)} />
      ) : (
        <>
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold">
              <Wrench className="h-6 w-6" style={{ color: "var(--accent)" }} /> Development
            </h1>
            <p className="text-sm" style={{ color: "var(--text-dim)" }}>
              Projects, deploys, and repo structure — pick a project to open its workspace.
            </p>
          </div>

          {warnings.length > 0 && (
            <div
              className="card flex items-start gap-2 p-3 text-xs"
              style={{ color: "var(--amber)" }}
            >
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                {warnings.map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
              </div>
            </div>
          )}

          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
              style={{ color: "var(--text-faint)" }}
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects…"
              className="w-full rounded-lg border bg-transparent py-2 pl-9 pr-3 text-sm outline-none"
              style={{ borderColor: "var(--card-border)", color: "var(--text)" }}
            />
          </div>

          {projectsError ? (
            <div className="card p-6 text-center">
              <p className="text-sm" style={{ color: "var(--red)" }}>
                Failed to load projects: {projectsError}
              </p>
              <button
                onClick={() => {
                  setProjectsError(null);
                  setProjects(null);
                  loadProjects();
                }}
                className="mt-3 inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium"
                style={{ background: "var(--accent)", color: "#fff" }}
              >
                <RefreshCw className="h-4 w-4" /> Retry
              </button>
            </div>
          ) : !projects ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <SkeletonCard key={i} />
              ))}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((p) => (
                <button
                  key={p.name}
                  onClick={() => setSelected(p)}
                  className="card card-hover p-4 text-left"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-semibold">{titleCase(p.name)}</span>
                    <ChevronRight className="h-4 w-4 shrink-0" style={{ color: "var(--text-faint)" }} />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {p.source === "both" && <Badge color="var(--accent)">Vercel + GitHub</Badge>}
                    {p.source === "vercel" && <Badge color="var(--accent)">Vercel</Badge>}
                    {p.source === "github" && <Badge color="var(--accent-2)">GitHub</Badge>}
                    {p.private ? (
                      <Badge color="var(--amber)">
                        <Lock className="h-2.5 w-2.5" /> Private
                      </Badge>
                    ) : (
                      <Badge color="var(--green)">
                        <Globe className="h-2.5 w-2.5" /> Public
                      </Badge>
                    )}
                    {p.framework && <Badge color="var(--text-faint)">{p.framework}</Badge>}
                  </div>
                  {p.description && (
                    <p className="mt-2 line-clamp-2 text-xs" style={{ color: "var(--text-dim)" }}>
                      {p.description}
                    </p>
                  )}
                  <div className="mt-3 text-[11px]" style={{ color: "var(--text-faint)" }}>
                    Pushed {fmtSASTRelative(p.pushedAt ?? p.updatedAt)}
                  </div>
                </button>
              ))}
              {filtered.length === 0 && (
                <div className="col-span-full card p-6 text-center text-sm" style={{ color: "var(--text-faint)" }}>
                  No projects match &quot;{query}&quot;.
                </div>
              )}
            </div>
          )}

          <ArtifactsSection />
        </>
      )}
    </div>
  );
}

// ── Artifacts section (wired to the real /api/artifacts) ────────────────

function ArtifactsSection() {
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/artifacts", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (cancelled) return;
        setArtifacts(Array.isArray(data.artifacts) ? data.artifacts : []);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!artifacts) return [];
    const query = q.trim().toLowerCase();
    if (!query) return artifacts;
    return artifacts.filter(
      (a) =>
        (a.title ?? "").toLowerCase().includes(query) ||
        (a.kind ?? "").toLowerCase().includes(query) ||
        (a.repo ?? "").toLowerCase().includes(query)
    );
  }, [artifacts, q]);

  return (
    <section className="card p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
        <Boxes className="h-4 w-4" /> Artifacts
      </h2>
      <div className="relative mb-4">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
          style={{ color: "var(--text-faint)" }}
        />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search everything Hermes produced…"
          className="w-full rounded-lg border bg-transparent py-2 pl-9 pr-3 text-sm outline-none"
          style={{ borderColor: "var(--card-border)", color: "var(--text)" }}
        />
      </div>
      {error ? (
        <p className="text-sm" style={{ color: "var(--red)" }}>
          Failed to load artifacts: {error}
        </p>
      ) : !artifacts ? (
        <div className="space-y-2">
          <div className="skeleton h-4 w-full" />
          <div className="skeleton h-4 w-3/4" />
          <div className="skeleton h-4 w-1/2" />
        </div>
      ) : (
        <ul className="space-y-2 text-sm">
          {filtered.map((a, i) => (
            <li key={`${a.title}-${i}`}>
              <a
                href={a.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 hover:underline"
                style={{ color: "var(--accent-2)" }}
              >
                <span
                  className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase"
                  style={{ background: "rgba(124,108,255,0.12)", color: "var(--accent)" }}
                >
                  {a.kind}
                </span>
                <span className="truncate">{a.title}</span>
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            </li>
          ))}
          {filtered.length === 0 && (
            <li style={{ color: "var(--text-faint)" }}>No artifacts match &quot;{q}&quot;.</li>
          )}
        </ul>
      )}
    </section>
  );
}

// ── Project workspace ───────────────────────────────────────────────────

function Workspace({ project, onBack }: { project: Project; onBack: () => void }) {
  const [tab, setTab] = useState<Tab>("files");

  return (
    <div className="space-y-4">
      <button
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-sm font-medium"
        style={{ color: "var(--accent-2)" }}
      >
        <ArrowLeft className="h-4 w-4" /> Back to Projects
      </button>

      <div className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold">{titleCase(project.name)}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs" style={{ color: "var(--text-dim)" }}>
              {project.repo && (
                <a
                  href={`https://github.com/${project.repo}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 hover:underline"
                  style={{ color: "var(--accent-2)" }}
                >
                  <GitBranch className="h-3.5 w-3.5" /> {project.repo}
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
              {project.defaultBranch && (
                <span className="font-mono">branch: {project.defaultBranch}</span>
              )}
              <span>Pushed {fmtSASTRelative(project.pushedAt ?? project.updatedAt)}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {project.source === "both" && <Badge color="var(--accent)">Vercel + GitHub</Badge>}
            {project.source === "vercel" && <Badge color="var(--accent)">Vercel</Badge>}
            {project.source === "github" && <Badge color="var(--accent-2)">GitHub</Badge>}
            {project.private ? (
              <Badge color="var(--amber)">
                <Lock className="h-2.5 w-2.5" /> Private
              </Badge>
            ) : (
              <Badge color="var(--green)">
                <Globe className="h-2.5 w-2.5" /> Public
              </Badge>
            )}
            {project.framework && <Badge color="var(--text-faint)">{project.framework}</Badge>}
          </div>
        </div>
        {project.description && (
          <p className="mt-3 text-sm" style={{ color: "var(--text-dim)" }}>
            {project.description}
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {(
          [
            { id: "files", label: "Files", icon: Folder },
            { id: "commits", label: "Commits", icon: GitCommit },
            { id: "deployments", label: "Deployments", icon: Rocket },
            { id: "chat", label: "Chat", icon: MessageSquare },
          ] as { id: Tab; label: string; icon: typeof Folder }[]
        ).map((t) => {
          const active = tab === t.id;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium"
              style={
                active
                  ? { background: "var(--accent)", color: "#fff" }
                  : { background: "transparent", color: "var(--text-dim)" }
              }
            >
              <Icon className="h-4 w-4" /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === "files" && <DevFilesTab project={project} />}
      {tab === "commits" && <DevCommitsTab project={project} />}
      {tab === "deployments" && <DeploymentsTab project={project} />}
      {tab === "chat" && <DevChatTab project={project} />}
    </div>
  );
}

// ── Deployments tab ──────────────────────────────────────────────────────

function DeploymentsTab({ project }: { project: Project }) {
  const [vercel, setVercel] = useState<VercelDeploy[] | null>(null);
  const [github, setGithub] = useState<GhDeploy[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/dev/projects/${project.name}/deployments`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (cancelled) return;
        setVercel(data.vercel ?? []);
        setGithub(data.github ?? []);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [project.name]);

  const loading = vercel === null && github === null;

  return (
    <div className="space-y-4">
      {error && (
        <div className="card p-4 text-sm" style={{ color: "var(--red)" }}>
          Failed to load deployments: {error}
        </div>
      )}

      <div className="card p-5">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
          <Rocket className="h-4 w-4" /> Vercel Deployments
        </h2>
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="skeleton h-10 w-full" />
            ))}
          </div>
        ) : vercel && vercel.length > 0 ? (
          <ul className="space-y-2">
            {vercel.map((d) => (
              <li key={d.uid} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2 py-1.5 hover:bg-white/5">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: readyStateColor(d.readyState) }}
                />
                <div className="min-w-0 flex-1 basis-full sm:basis-auto">
                  {d.url ? (
                    <a
                      href={`https://${d.url}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex max-w-full items-center gap-1 truncate text-sm hover:underline"
                      style={{ color: "var(--accent-2)" }}
                    >
                      <span className="truncate">{d.url}</span>
                      <ExternalLink className="h-3 w-3 shrink-0" />
                    </a>
                  ) : (
                    <span className="break-all text-sm">{d.uid}</span>
                  )}
                  <div className="text-[11px]" style={{ color: "var(--text-faint)" }}>
                    {fmtSASTRelative(d.created)}
                  </div>
                </div>
                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                  <Badge color={readyStateColor(d.readyState)}>{d.readyState}</Badge>
                  {d.target && <Badge color="var(--text-faint)">{d.target}</Badge>}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm" style={{ color: "var(--text-faint)" }}>
            No Vercel deployments for this project.
          </p>
        )}
      </div>

      <div className="card p-5">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
          <GitBranch className="h-4 w-4" /> GitHub Deployments
        </h2>
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="skeleton h-10 w-full" />
            ))}
          </div>
        ) : github && github.length > 0 ? (
          <ul className="space-y-2">
            {github.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2 py-1.5 hover:bg-white/5">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: "var(--accent-2)" }} />
                <div className="min-w-0 flex-1 basis-full sm:basis-auto">
                  <span className="block truncate text-sm">{d.environment}</span>
                  <div className="truncate text-[11px]" style={{ color: "var(--text-faint)" }}>
                    {d.ref} · {fmtSASTRelative(d.created_at)}
                  </div>
                </div>
                <span className="ml-auto shrink-0">
                  <Badge color="var(--text-faint)">{d.environment}</Badge>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm" style={{ color: "var(--text-faint)" }}>
            No GitHub deployments for this project.
          </p>
        )}
      </div>
    </div>
  );
}

// ── Chat tab ─────────────────────────────────────────────────────────────
