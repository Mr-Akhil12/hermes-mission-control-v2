"use client";

import { useState, useEffect, useCallback } from "react";
import { User, NotebookPen, Brain, FolderOpen, FileText, ChevronRight, RefreshCw, Search } from "lucide-react";

type MemoryFile = {
  file: string;
  entries: string[];
  size: number;
};

type Folder = { name: string; count: number };

type Note = {
  name: string;
  file: string;
  folder: string;
  date: string;
  tags: string;
  preview: string;
  size: number;
};

type NoteDetail = {
  name: string;
  file: string;
  folder: string;
  meta: Record<string, string>;
  body: string;
  size: number;
};

export default function PersonalPage() {
  const [view, setView] = useState<"memory" | "vault">("memory");
  const [memory, setMemory] = useState<MemoryFile[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const [note, setNote] = useState<NoteDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const loadMemory = useCallback(async () => {
    try {
      const res = await fetch("/api/personal/memory", { cache: "no-store" });
      const data = await res.json();
      setMemory(data?.memory ?? []);
      setError(null);
    } catch (e) {
      setError(`Failed to load memory: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadVault = useCallback(async () => {
    try {
      const res = await fetch("/api/personal/vault", { cache: "no-store" });
      const data = await res.json();
      setFolders(data?.folders ?? []);
      setError(null);
    } catch (e) {
      setError(`Failed to load vault: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view === "memory") loadMemory();
    else loadVault();
  }, [view, loadMemory, loadVault]);

  const openFolder = async (folder: string) => {
    setCurrentFolder(folder);
    setNote(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/personal/vault/notes/${encodeURIComponent(folder)}`, { cache: "no-store" });
      const data = await res.json();
      setNotes(data?.notes ?? []);
      setError(null);
    } catch (e) {
      setError(`Failed to load notes: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLoading(false);
    }
  };

  const openNote = async (folder: string, file: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/personal/vault/note/${encodeURIComponent(folder)}/${encodeURIComponent(file)}`, { cache: "no-store" });
      const data = await res.json();
      setNote(data);
      setError(null);
    } catch (e) {
      setError(`Failed to load note: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLoading(false);
    }
  };

  const filteredNotes = query
    ? notes.filter((n) => n.name.toLowerCase().includes(query.toLowerCase()) || n.preview.toLowerCase().includes(query.toLowerCase()))
    : notes;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <User className="h-6 w-6" style={{ color: "var(--accent)" }} />
          <div>
            <h1 className="text-2xl font-bold">Personal</h1>
            <p className="text-sm" style={{ color: "var(--text-dim)" }}>
              Hermes memory + Obsidian vault — your second brain.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border" style={{ borderColor: "var(--card-border)" }}>
            <button
              onClick={() => setView("memory")}
              className="flex items-center gap-1.5 rounded-l-lg px-3 py-2 text-sm font-semibold"
              style={{ background: view === "memory" ? "rgba(124,108,255,0.15)" : "transparent", color: view === "memory" ? "var(--accent)" : "var(--text-dim)" }}
            >
              <Brain className="h-4 w-4" /> Memory
            </button>
            <button
              onClick={() => setView("vault")}
              className="flex items-center gap-1.5 rounded-r-lg px-3 py-2 text-sm font-semibold"
              style={{ background: view === "vault" ? "rgba(124,108,255,0.15)" : "transparent", color: view === "vault" ? "var(--accent)" : "var(--text-dim)" }}
            >
              <FolderOpen className="h-4 w-4" /> Vault
            </button>
          </div>
          <button
            onClick={() => (view === "memory" ? loadMemory() : loadVault())}
            className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
            style={{ borderColor: "var(--card-border)", color: "var(--text-dim)" }}
          >
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="card border px-4 py-3 text-sm" style={{ borderColor: "color-mix(in srgb, var(--red) 40%, transparent)", color: "var(--red)" }}>
          {error}
        </div>
      )}

      {loading ? (
        <div className="card p-8 text-center text-sm" style={{ color: "var(--text-dim)" }}>
          Loading…
        </div>
      ) : view === "memory" ? (
        <div className="space-y-4">
          {memory.map((m) => (
            <div key={m.file} className="card p-5">
              <div className="flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-faint)" }}>
                  <Brain className="h-4 w-4" /> {m.file} · {m.entries.length} entries
                </h2>
                <span className="text-[10px]" style={{ color: "var(--text-faint)" }}>{m.size} bytes</span>
              </div>
              <div className="mt-3 space-y-2">
                {m.entries.map((e, i) => (
                  <div key={i} className="rounded-lg border p-3 text-sm" style={{ borderColor: "var(--card-border)" }}>
                    {e}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : note ? (
        <div className="card p-6">
          <button
            onClick={() => { setNote(null); openFolder(note.folder); }}
            className="mb-3 flex items-center gap-1 text-xs font-semibold"
            style={{ color: "var(--accent)" }}
          >
            <ChevronRight className="h-3 w-3 rotate-180" /> Back to {note.folder}
          </button>
          <h2 className="text-xl font-bold">{note.name}</h2>
          <div className="mt-1 flex flex-wrap gap-2 text-[10px]" style={{ color: "var(--text-faint)" }}>
            <span className="rounded px-1.5 py-0.5" style={{ background: "color-mix(in srgb, var(--bg) 60%, transparent)" }}>{note.folder}</span>
            {note.meta.date && <span>{note.meta.date}</span>}
            {note.meta.tags && <span>{note.meta.tags}</span>}
          </div>
          <div className="mt-4 whitespace-pre-wrap text-sm leading-relaxed" style={{ color: "var(--text-dim)" }}>
            {note.body}
          </div>
        </div>
      ) : currentFolder ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              onClick={() => { setCurrentFolder(null); setNotes([]); }}
              className="flex items-center gap-1 text-xs font-semibold"
              style={{ color: "var(--accent)" }}
            >
              <ChevronRight className="h-3 w-3 rotate-180" /> All folders
            </button>
            <div className="flex items-center gap-2 rounded-lg border px-3 py-1.5" style={{ borderColor: "var(--card-border)" }}>
              <Search className="h-3.5 w-3.5" style={{ color: "var(--text-faint)" }} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${currentFolder}…`}
                className="bg-transparent text-sm outline-none"
                style={{ color: "var(--text)" }}
              />
            </div>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {filteredNotes.map((n) => (
              <button
                key={n.file}
                onClick={() => openNote(n.folder, n.file)}
                className="card p-4 text-left"
              >
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 shrink-0" style={{ color: "var(--accent-2)" }} />
                  <span className="truncate text-sm font-semibold">{n.name}</span>
                </div>
                {n.date && <div className="mt-1 text-[10px]" style={{ color: "var(--text-faint)" }}>{n.date}</div>}
                {n.preview && (
                  <div className="mt-1.5 line-clamp-2 text-xs" style={{ color: "var(--text-dim)" }}>{n.preview}</div>
                )}
              </button>
            ))}
          </div>
          {filteredNotes.length === 0 && (
            <div className="card p-8 text-center text-sm" style={{ color: "var(--text-dim)" }}>
              No notes match "{query}".
            </div>
          )}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {folders.map((f) => (
            <button key={f.name} onClick={() => openFolder(f.name)} className="card p-5 text-left">
              <div className="flex items-center justify-between">
                <FolderOpen className="h-5 w-5" style={{ color: "var(--accent-2)" }} />
                <ChevronRight className="h-4 w-4" style={{ color: "var(--text-faint)" }} />
              </div>
              <div className="mt-2 font-semibold">{f.name}</div>
              <div className="text-xs" style={{ color: "var(--text-faint)" }}>{f.count} notes</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
