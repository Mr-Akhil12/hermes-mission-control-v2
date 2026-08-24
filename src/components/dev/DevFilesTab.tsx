"use client";

import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  Loader2,
  Search,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

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

type TreeEntry = { path: string; type: "file" | "dir"; size: number };

type TreeNode = {
  name: string;
  type: "dir" | "file";
  size: number;
  children: Record<string, TreeNode>;
};

type FileContents = {
  path: string;
  size: number;
  content: string;
  truncated: boolean;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function DevFilesTab({ project }: { project: Project }) {
  const [tree, setTree] = useState<TreeEntry[] | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [file, setFile] = useState<FileContents | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/dev/projects/${encodeURIComponent(project.name)}/tree`, {
      cache: "no-store",
    })
      .then((response) =>
        response.ok
          ? response.json()
          : Promise.reject(new Error(`HTTP ${response.status}`))
      )
      .then((data) => {
        if (!cancelled) setTree(data.tree ?? []);
      })
      .catch((error) => {
        if (!cancelled) {
          setTreeError(error instanceof Error ? error.message : String(error));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [project.name]);

  useEffect(() => {
    if (!selectedPath) return;

    const controller = new AbortController();
    const searchParams = new URLSearchParams({ path: selectedPath });

    fetch(
      `/api/dev/projects/${encodeURIComponent(project.name)}/file?${searchParams.toString()}`,
      { cache: "no-store", signal: controller.signal }
    )
      .then(async (response) => {
        const data = (await response.json()) as FileContents & { error?: string };
        if (!response.ok) {
          throw new Error(data.error || `HTTP ${response.status}`);
        }
        return data;
      })
      .then((data) => {
        setFile(data);
        setFileLoading(false);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setFileError(error instanceof Error ? error.message : String(error));
        setFileLoading(false);
      });

    return () => controller.abort();
  }, [project.name, reloadVersion, selectedPath]);

  const filtered = useMemo(() => {
    if (!tree) return [];
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return tree;
    return tree.filter((entry) =>
      entry.path.toLowerCase().includes(normalizedQuery)
    );
  }, [query, tree]);

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
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        const isLast = index === parts.length - 1;
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
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const selectFile = (path: string) => {
    if (path === selectedPath) return;
    setSelectedPath(path);
    setFile(null);
    setFileError(null);
    setFileLoading(true);
  };

  const closeFile = () => {
    setSelectedPath(null);
    setFile(null);
    setFileError(null);
    setFileLoading(false);
  };

  const retryFile = () => {
    setFile(null);
    setFileError(null);
    setFileLoading(true);
    setReloadVersion((version) => version + 1);
  };

  const renderNode = (node: TreeNode, depth: number, path: string) => {
    const isDirectory = node.type === "dir";
    const isOpen = query.trim() ? true : expanded.has(path);
    const children = Object.values(node.children);
    const showChildren = isDirectory && isOpen && children.length > 0;
    const isSelected = !isDirectory && path === selectedPath;

    return (
      <div key={path || "root"}>
        <button
          type="button"
          onClick={() => {
            if (isDirectory) toggle(path);
            else selectFile(path);
          }}
          className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-sm hover:bg-white/5"
          style={{
            paddingLeft: depth * 16 + 4,
            background: isSelected
              ? "color-mix(in srgb, var(--accent) 12%, transparent)"
              : undefined,
          }}
        >
          {isDirectory ? (
            isOpen ? (
              <ChevronDown
                className="h-3.5 w-3.5 shrink-0"
                style={{ color: "var(--text-faint)" }}
              />
            ) : (
              <ChevronRight
                className="h-3.5 w-3.5 shrink-0"
                style={{ color: "var(--text-faint)" }}
              />
            )
          ) : (
            <span className="w-3.5 shrink-0" />
          )}
          {isDirectory ? (
            <Folder
              className="h-4 w-4 shrink-0"
              style={{ color: "var(--accent-2)" }}
            />
          ) : (
            <File
              className="h-4 w-4 shrink-0"
              style={{ color: "var(--text-faint)" }}
            />
          )}
          <span
            className="truncate"
            style={{
              color: isDirectory ? "var(--text)" : "var(--text-dim)",
            }}
          >
            {node.name}
          </span>
          {!isDirectory && node.size > 0 && (
            <span
              className="ml-auto shrink-0 font-mono text-[10px]"
              style={{ color: "var(--text-faint)" }}
            >
              {formatBytes(node.size)}
            </span>
          )}
        </button>
        {showChildren && (
          <div>
            {children.map((child) =>
              renderNode(
                child,
                depth + 1,
                path ? `${path}/${child.name}` : child.name
              )
            )}
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
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search files…"
          className="w-full rounded-lg border bg-transparent py-2 pl-9 pr-3 text-sm outline-none"
          style={{
            borderColor: "var(--card-border)",
            color: "var(--text)",
          }}
        />
      </div>

      {treeError ? (
        <p className="text-sm" style={{ color: "var(--red)" }}>
          Failed to load file tree: {treeError}
        </p>
      ) : !tree ? (
        <div className="space-y-1.5">
          {Array.from({ length: 8 }).map((_, index) => (
            <div
              key={index}
              className="skeleton h-4 w-full"
              style={{ width: `${60 + ((index * 13) % 35)}%` }}
            />
          ))}
        </div>
      ) : (
        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(240px,0.8fr)_minmax(0,1.7fr)]">
          <div
            className="max-h-[500px] min-h-56 overflow-y-auto rounded-lg border p-2"
            style={{ borderColor: "var(--card-border)" }}
          >
            {Object.values(nested.children).map((child) =>
              renderNode(child, 0, child.name)
            )}
            {filtered.length === 0 && (
              <p
                className="py-4 text-center text-sm"
                style={{ color: "var(--text-faint)" }}
              >
                No files match &quot;{query}&quot;.
              </p>
            )}
          </div>

          <div
            className="min-w-0 overflow-hidden rounded-lg border"
            style={{ borderColor: "var(--card-border)" }}
          >
            {!selectedPath ? (
              <div
                className="flex min-h-56 items-center justify-center p-6 text-center text-sm"
                style={{ color: "var(--text-faint)" }}
              >
                Select a file to view its contents.
              </div>
            ) : (
              <>
                <div
                  className="flex min-w-0 items-center gap-3 border-b px-3 py-2"
                  style={{ borderColor: "var(--card-border)" }}
                >
                  <File
                    className="h-4 w-4 shrink-0"
                    style={{ color: "var(--accent-2)" }}
                  />
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-xs"
                    title={selectedPath}
                    style={{ color: "var(--text)" }}
                  >
                    {selectedPath}
                  </span>
                  {file && (
                    <span
                      className="shrink-0 font-mono text-[10px]"
                      style={{ color: "var(--text-faint)" }}
                    >
                      {formatBytes(file.size)}
                    </span>
                  )}
                  {file?.truncated && (
                    <span
                      className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                      style={{
                        background:
                          "color-mix(in srgb, var(--amber) 14%, transparent)",
                        color: "var(--amber)",
                      }}
                    >
                      Truncated
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={closeFile}
                    className="rounded p-1 hover:bg-white/5"
                    aria-label="Close file viewer"
                    title="Close file"
                  >
                    <X
                      className="h-4 w-4"
                      style={{ color: "var(--text-faint)" }}
                    />
                  </button>
                </div>

                {fileLoading ? (
                  <div
                    className="flex min-h-56 items-center justify-center gap-2 text-sm"
                    style={{ color: "var(--text-dim)" }}
                  >
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading file…
                  </div>
                ) : fileError ? (
                  <div className="flex min-h-56 flex-col items-center justify-center gap-3 p-6 text-center">
                    <p className="text-sm" style={{ color: "var(--red)" }}>
                      Failed to load file: {fileError}
                    </p>
                    <button
                      type="button"
                      onClick={retryFile}
                      className="rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-white/5"
                      style={{
                        borderColor: "var(--card-border)",
                        color: "var(--text-dim)",
                      }}
                    >
                      Retry
                    </button>
                  </div>
                ) : file ? (
                  <div
                    className="max-h-[500px] overflow-auto"
                    style={{ background: "color-mix(in srgb, var(--bg) 60%, transparent)" }}
                  >
                    <div className="min-w-max font-mono text-xs leading-5">
                      {file.content.split("\n").map((line, index) => (
                        <div key={index} className="flex min-w-full">
                          <span
                            className="sticky left-0 w-12 shrink-0 select-none border-r pr-3 text-right"
                            style={{
                              background: "var(--card)",
                              borderColor: "var(--card-border)",
                              color: "var(--text-faint)",
                            }}
                          >
                            {index + 1}
                          </span>
                          <span
                            className="whitespace-pre px-4"
                            style={{ color: "var(--text-dim)" }}
                          >
                            {line || "\u00a0"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
