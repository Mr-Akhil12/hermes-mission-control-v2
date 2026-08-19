"use client";

import {
  Wrench,
  Search,
  ArrowLeft,
  Folder,
  File,
  GitCommit,
  Rocket,
  MessageSquare,
  ExternalLink,
  ChevronRight,
  ChevronDown,
  Lock,
  Globe,
  RefreshCw,
  Send,
  Loader2,
  Boxes,
  GitBranch,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtSASTRelative } from "@/lib/time";

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

type TreeEntry = { path: string; type: "file" | "dir"; size: number };
type Commit = { sha: string; message: string; author: string; date: string | null };
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

function formatBytes(n: number): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function shortSha(sha: string): string {
  return sha ? sha.slice(0, 7) : "";
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

      {tab === "files" && <FilesTab project={project} />}
      {tab === "commits" && <CommitsTab project={project} />}
      {tab === "deployments" && <DeploymentsTab project={project} />}
      {tab === "chat" && <ChatTab project={project} />}
    </div>
  );
}

// ── Files tab ───────────────────────────────────────────────────────────

function FilesTab({ project }: { project: Project }) {
  const [tree, setTree] = useState<TreeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/dev/projects/${project.name}/tree`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (cancelled) return;
        setTree(data.tree ?? []);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [project.name]);

  const filtered = useMemo(() => {
    if (!tree) return [];
    const query = q.trim().toLowerCase();
    if (!query) return tree;
    return tree.filter((e) => e.path.toLowerCase().includes(query));
  }, [tree, q]);

  // Build a nested structure for rendering.
  type TreeNode = {
    name: string;
    type: "dir" | "file";
    size: number;
    children: Record<string, TreeNode>;
  };
  const nested = useMemo(() => {
    const root: TreeNode = {
      name: "",
      type: "dir",
      size: 0,
      children: {},
    };
    for (const entry of filtered) {
      const parts = entry.path.split("/");
      let node = root;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const isLast = i === parts.length - 1;
        if (!node.children[part]) {
          node.children[part] = {
            name: part,
            type: isLast ? entry.type : "dir",
            size: isLast ? entry.size : 0,
            children: {},
          };
        }
        node = node.children[part];
      }
    }
    return root;
  }, [filtered]);

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderNode = (node: TreeNode, depth: number, path: string) => {
    const isDir = node.type === "dir";
    const isOpen = expanded.has(path);
    const children = Object.values(node.children);
    const showChildren = isDir && isOpen && children.length > 0;

    return (
      <div key={path || "root"}>
        <button
          onClick={() => {
            if (isDir) toggle(path);
            else setSelectedPath(path);
          }}
          className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-sm hover:bg-white/5"
          style={{ paddingLeft: depth * 16 + 4 }}
        >
          {isDir ? (
            isOpen ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--text-faint)" }} />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--text-faint)" }} />
            )
          ) : (
            <span className="w-3.5 shrink-0" />
          )}
          {isDir ? (
            <Folder className="h-4 w-4 shrink-0" style={{ color: "var(--accent-2)" }} />
          ) : (
            <File className="h-4 w-4 shrink-0" style={{ color: "var(--text-faint)" }} />
          )}
          <span className="truncate" style={{ color: isDir ? "var(--text)" : "var(--text-dim)" }}>
            {node.name}
          </span>
          {!isDir && node.size > 0 && (
            <span className="ml-auto shrink-0 font-mono text-[10px]" style={{ color: "var(--text-faint)" }}>
              {formatBytes(node.size)}
            </span>
          )}
        </button>
        {showChildren && (
          <div>
            {children.map((child: TreeNode) => renderNode(child, depth + 1, path ? `${path}/${child.name}` : child.name))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="card p-5">
      <div className="relative mb-4">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
          style={{ color: "var(--text-faint)" }}
        />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search files…"
          className="w-full rounded-lg border bg-transparent py-2 pl-9 pr-3 text-sm outline-none"
          style={{ borderColor: "var(--card-border)", color: "var(--text)" }}
        />
      </div>

      {error ? (
        <p className="text-sm" style={{ color: "var(--red)" }}>
          Failed to load file tree: {error}
        </p>
      ) : !tree ? (
        <div className="space-y-1.5">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="skeleton h-4 w-full" style={{ width: `${60 + ((i * 13) % 35)}%` }} />
          ))}
        </div>
      ) : (
        <>
          <div className="max-h-[420px] overflow-y-auto pr-1">
            {Object.values(nested.children).map((child: TreeNode) => renderNode(child, 0, child.name))}
            {filtered.length === 0 && (
              <p className="py-4 text-center text-sm" style={{ color: "var(--text-faint)" }}>
                No files match &quot;{q}&quot;.
              </p>
            )}
          </div>
          {selectedPath && (
            <div
              className="mt-3 rounded-lg px-3 py-2 font-mono text-xs"
              style={{ background: "color-mix(in srgb, var(--bg) 60%, transparent)", color: "var(--accent-2)" }}
            >
              {selectedPath}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Commits tab ─────────────────────────────────────────────────────────

function CommitsTab({ project }: { project: Project }) {
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/dev/projects/${project.name}/commits`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (cancelled) return;
        setCommits(data.commits ?? []);
        setBranch(data.branch ?? null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [project.name]);

  return (
    <div className="card p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
          Recent Commits
        </h2>
        {branch && <span className="font-mono text-xs" style={{ color: "var(--text-dim)" }}>{branch}</span>}
      </div>
      {error ? (
        <p className="text-sm" style={{ color: "var(--red)" }}>Failed to load commits: {error}</p>
      ) : !commits ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="skeleton h-10 w-full" />
          ))}
        </div>
      ) : commits.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--text-faint)" }}>No commits found.</p>
      ) : (
        <ul className="space-y-2">
          {commits.map((c) => (
            <li key={c.sha} className="flex items-start gap-3 rounded-lg px-2 py-1.5 hover:bg-white/5">
              <span
                className="mt-0.5 shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]"
                style={{ background: "color-mix(in srgb, var(--accent) 14%, transparent)", color: "var(--accent)" }}
              >
                {shortSha(c.sha)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{c.message}</p>
                <p className="text-[11px]" style={{ color: "var(--text-faint)" }}>
                  {c.author} · {fmtSASTRelative(c.date)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
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
              <li key={d.uid} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-white/5">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: readyStateColor(d.readyState) }}
                />
                <div className="min-w-0 flex-1">
                  {d.url ? (
                    <a
                      href={`https://${d.url}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 truncate text-sm hover:underline"
                      style={{ color: "var(--accent-2)" }}
                    >
                      {d.url}
                      <ExternalLink className="h-3 w-3 shrink-0" />
                    </a>
                  ) : (
                    <span className="text-sm">{d.uid}</span>
                  )}
                  <div className="text-[11px]" style={{ color: "var(--text-faint)" }}>
                    {fmtSASTRelative(d.created)}
                  </div>
                </div>
                <Badge color={readyStateColor(d.readyState)}>{d.readyState}</Badge>
                {d.target && <Badge color="var(--text-faint)">{d.target}</Badge>}
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
              <li key={d.id} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-white/5">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: "var(--accent-2)" }} />
                <div className="min-w-0 flex-1">
                  <span className="truncate text-sm">{d.environment}</span>
                  <div className="text-[11px]" style={{ color: "var(--text-faint)" }}>
                    {d.ref} · {fmtSASTRelative(d.created_at)}
                  </div>
                </div>
                <Badge color="var(--text-faint)">{d.environment}</Badge>
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

type ChatMessage = { role: "user" | "assistant"; text: string; runId?: string | null; queued?: boolean };

function ChatTab({ project }: { project: Project }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setError(null);
    setMessages((prev) => [...prev, { role: "user", text }]);
    setSending(true);
    try {
      const res = await fetch(`/api/dev/projects/${project.name}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        setMessages((prev) => [...prev, { role: "assistant", text: `Error: ${data.error ?? res.status}` }]);
      } else {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", text: data.message ?? "Run started.", runId: data.run_id, queued: data.queued },
        ]);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setMessages((prev) => [...prev, { role: "assistant", text: `Error: ${msg}` }]);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="card flex h-[480px] flex-col p-5">
      <p className="mb-3 text-xs" style={{ color: "var(--text-faint)" }}>
        This chat is bound to {titleCase(project.name)} — Hermes knows what project you&apos;re working on.
      </p>

      <div className="flex-1 space-y-3 overflow-y-auto pr-1">
        {messages.length === 0 && (
          <p className="py-8 text-center text-sm" style={{ color: "var(--text-faint)" }}>
            Ask anything about {titleCase(project.name)} — plan changes, explain the codebase, or draft commands.
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className="max-w-[85%] rounded-lg px-3 py-2 text-sm"
            style={
              m.role === "user"
                ? { background: "var(--accent)", color: "#fff", marginLeft: "auto" }
                : { background: "color-mix(in srgb, var(--bg) 60%, transparent)", color: "var(--text)" }
            }
          >
            {m.text}
            {m.runId && (
              <div className="mt-1 font-mono text-[10px]" style={{ color: m.role === "user" ? "rgba(255,255,255,0.8)" : "var(--text-faint)" }}>
                run: {m.runId}
              </div>
            )}
            {m.queued && (
              <div className="mt-1 text-[10px]" style={{ color: m.role === "user" ? "rgba(255,255,255,0.8)" : "var(--amber)" }}>
                queued
              </div>
            )}
          </div>
        ))}
        {sending && (
          <div className="flex items-center gap-2 text-sm" style={{ color: "var(--text-faint)" }}>
            <Loader2 className="h-4 w-4 animate-spin" /> Dispatching…
          </div>
        )}
      </div>

      {error && (
        <p className="mt-2 text-xs" style={{ color: "var(--red)" }}>{error}</p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
          placeholder={`Message ${titleCase(project.name)}…`}
          className="flex-1 rounded-lg border bg-transparent px-3 py-2 text-sm outline-none"
          style={{ borderColor: "var(--card-border)", color: "var(--text)" }}
        />
        <button
          onClick={send}
          disabled={sending || !input.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-50"
          style={{ background: "var(--accent)", color: "#fff" }}
        >
          <Send className="h-4 w-4" /> Send
        </button>
      </div>
    </div>
  );
}
