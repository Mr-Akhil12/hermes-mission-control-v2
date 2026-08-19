import { useCallback, useState } from "react";
import type { SessionMeta } from "@/lib/chat-types";

export type SessionFilter = "chats" | "all";

// Options passed to useSessions(). The page owns its single `error` banner
// (used by ~30 other code paths beyond session loading), so the hook reports
// session-load failures into that same setError to keep render behavior
// byte-for-byte identical to the original inline implementation.
export type UseSessionsOptions = {
  setError: (msg: string | null) => void;
};

export function useSessions({ setError }: UseSessionsOptions) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>("chats");

  const loadSessions = useCallback(
    async (source?: SessionFilter) => {
      try {
        const src = source ?? sessionFilter;
        const qs = src === "all" ? "?source=all" : "?source=dashboard";
        const res = await fetch(`/api/chat/sessions${qs}`, { cache: "no-store" });
        const data = await res.json();
        const list: SessionMeta[] = data?.data ?? data?.sessions ?? [];
        setSessions(list);
        return list;
      } catch (e) {
        setError(`Failed to load conversations: ${e instanceof Error ? e.message : e}`);
        return [];
      } finally {
        setSessionsLoading(false);
      }
    },
    [sessionFilter, setError]
  );

  return {
    sessions,
    sessionsLoading,
    setSessionsLoading,
    activeId,
    setActiveId,
    sessionFilter,
    setSessionFilter,
    loadSessions,
  };
}
