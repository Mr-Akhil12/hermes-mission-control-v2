/** Yellow — XAUUSD-only gold trader ground truth + SAST session helpers. */

export const YELLOW_RULES = {
  name: "Yellow",
  symbol: "XAUUSD",
  style: "Liquidity sweeps + informed levels. Scalps 20s–15min.",
  windowsSAST: [
    { start: "06:00", end: "08:00", label: "AM London open" },
    { start: "18:00", end: "20:00", label: "PM NY / Asia handoff" },
  ] as const,
  oneLossDone: true,
  winCanContinue: true,
  maxLot: 0.01,
  mt5Url: "https://web.metatrader.app/terminal",
  mode: "DEMO" as const,
};

export type DayState = "ACTIVE" | "LOCKED_LOSS" | "IDLE";
export type SessionPhase = "IN_WINDOW" | "COUNTDOWN" | "OUT_OF_WINDOW";

export type YellowAccountStrip = {
  login: string;
  server: string;
  mode: "DEMO" | "LIVE";
  leverage: string;
  maxLot: number;
  mt5Url: string;
  startingBalanceHint: number;
};

export function yellowAccountFromEnv(): YellowAccountStrip {
  return {
    login: process.env.YELLOW_MT5_LOGIN ?? "10013006443",
    server: process.env.YELLOW_MT5_SERVER ?? "MetaQuotes-Demo",
    mode: (process.env.YELLOW_MT5_MODE ?? "DEMO").toUpperCase() === "LIVE" ? "LIVE" : "DEMO",
    leverage: process.env.YELLOW_MT5_LEVERAGE ?? "1:500",
    maxLot: Number(process.env.YELLOW_MT5_MAX_LOT ?? "0.01") || 0.01,
    mt5Url: process.env.YELLOW_MT5_URL ?? YELLOW_RULES.mt5Url,
    startingBalanceHint: Number(process.env.YELLOW_MT5_BALANCE_HINT ?? "15") || 15,
  };
}

function sastParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Johannesburg",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    dateKey: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function parseHm(hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

export type SessionClock = {
  phase: SessionPhase;
  label: string;
  windowLabel: string | null;
  sastNow: string;
  sastDate: string;
  minutesToNext: number | null;
  inWindow: boolean;
};

export function getSessionClock(now = new Date()): SessionClock {
  const p = sastParts(now);
  const sastNow = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}:${String(p.second).padStart(2, "0")}`;
  const windows = YELLOW_RULES.windowsSAST.map((w) => ({
    ...w,
    startMin: parseHm(w.start),
    endMin: parseHm(w.end),
  }));

  for (const w of windows) {
    if (p.minutes >= w.startMin && p.minutes < w.endMin) {
      return {
        phase: "IN_WINDOW",
        label: "IN WINDOW",
        windowLabel: `${w.start}–${w.end} SAST · ${w.label}`,
        sastNow,
        sastDate: p.dateKey,
        minutesToNext: null,
        inWindow: true,
      };
    }
  }

  // Find next window start today or tomorrow
  let next: { startMin: number; label: string; tomorrow?: boolean } | null = null;
  for (const w of windows) {
    if (p.minutes < w.startMin) {
      next = { startMin: w.startMin, label: `${w.start}–${w.end} SAST · ${w.label}` };
      break;
    }
  }
  if (!next) {
    const w = windows[0];
    next = {
      startMin: w.startMin + 24 * 60,
      label: `${w.start}–${w.end} SAST · ${w.label}`,
      tomorrow: true,
    };
  }
  const minutesToNext = next.startMin - p.minutes;
  // Countdown if within 30 min of next window
  const phase: SessionPhase = minutesToNext <= 30 ? "COUNTDOWN" : "OUT_OF_WINDOW";
  return {
    phase,
    label: phase === "COUNTDOWN" ? "COUNTDOWN" : "OUT OF WINDOW",
    windowLabel: next.label,
    sastNow,
    sastDate: p.dateKey,
    minutesToNext,
    inWindow: false,
  };
}

export type ClosedTradeLike = {
  result?: string | null;
  profit?: number | string | null;
  closed_at?: string | null;
  opened_at?: string | null;
  source?: string | null;
};

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** SAST calendar date key for a timestamp string. */
export function sastDateKey(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const normalized = iso.includes("T") ? iso : iso.replace(" ", "T") + (iso.endsWith("Z") ? "" : "Z");
  const d = new Date(normalized);
  if (isNaN(d.getTime())) return null;
  return sastParts(d).dateKey;
}

export function computeDayState(
  trades: ClosedTradeLike[],
  clock: SessionClock = getSessionClock()
): { dayState: DayState; todayLosses: number; todayWins: number; todayPnl: number } {
  const today = clock.sastDate;
  let todayLosses = 0;
  let todayWins = 0;
  let todayPnl = 0;

  for (const t of trades) {
    const key = sastDateKey(t.closed_at) ?? sastDateKey(t.opened_at);
    if (key !== today) continue;
    const result = String(t.result ?? "").toUpperCase();
    if (result === "PENDING") continue;
    const pnl = toNum(t.profit) ?? 0;
    todayPnl += pnl;
    if (result === "LOSS" || pnl < 0) todayLosses += 1;
    else if (result === "WIN" || pnl > 0) todayWins += 1;
  }

  if (todayLosses >= 1) {
    return { dayState: "LOCKED_LOSS", todayLosses, todayWins, todayPnl };
  }
  if (clock.inWindow) {
    return { dayState: "ACTIVE", todayLosses, todayWins, todayPnl };
  }
  return { dayState: "IDLE", todayLosses, todayWins, todayPnl };
}

export const YELLOW_RULES_FALLBACK: { title: string; body: string }[] = [
  {
    title: "Yellow ground truth",
    body: [
      "XAUUSD only. Liquidity sweeps + informed levels.",
      "Scalps 20 seconds to 15 minutes.",
      "Windows (SAST): 06:00–08:00 and 18:00–20:00.",
      "One loss → done for the day. Win → can keep trading in-window.",
      "Demo MetaQuotes · max 0.01 lot · hedge · follow + journal only (no auto-trade).",
    ].join("\n"),
  },
];
