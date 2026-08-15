// Shared SAST time formatting — Akhil's local time is ALWAYS SAST (UTC+2).
// Never show raw ISO or UTC timestamps anywhere in the dashboard.

const SAST = "Africa/Johannesburg";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function toDate(v: string | number | null | undefined): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/** "15 Aug, 23:15" — the default human format. */
export function fmtSAST(v: string | number | null | undefined): string {
  const d = toDate(v);
  if (!d) return "—";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: SAST,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")} ${get("month")}, ${get("hour")}:${get("minute")}`;
}

/** "15 Aug, 23:15:41" — with seconds, for run timestamps. */
export function fmtSASTSec(v: string | number | null | undefined): string {
  const d = toDate(v);
  if (!d) return "—";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: SAST,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")} ${get("month")}, ${get("hour")}:${get("minute")}:${get("second")}`;
}

/** "23:15" — time only. */
export function fmtSASTTime(v: string | number | null | undefined): string {
  const d = toDate(v);
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: SAST,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

/** "15 Aug" — date only. */
export function fmtSASTDate(v: string | number | null | undefined): string {
  const d = toDate(v);
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: SAST,
    day: "2-digit",
    month: "short",
  }).format(d);
}

/** Relative "5m ago" in SAST terms. */
export function fmtSASTRelative(v: string | number | null | undefined): string {
  const d = toDate(v);
  if (!d) return "—";
  const now = Date.now();
  const diff = Math.max(0, now - d.getTime());
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

/** Month name for grouping. */
export function monthName(v: string | number | null | undefined): string {
  const d = toDate(v);
  if (!d) return "";
  return MONTHS[d.getUTCMonth()];
}
