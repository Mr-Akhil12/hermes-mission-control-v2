// Cron expression → human-readable SAST schedule.
// Kills the raw "0 * * * *" asterisk format everywhere in the dashboard.

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad(n: number | string): string {
  return String(n).padStart(2, "0");
}

function fmtTime(h: number, m: number): string {
  return `${pad(h)}:${pad(m)}`;
}

function parseField(f: string): number[] | null {
  if (f === "*" || f === "?") return null;
  const out: number[] = [];
  for (const part of f.split(",")) {
    if (part.includes("/")) {
      const [base, step] = part.split("/");
      const start = base === "*" ? 0 : parseInt(base, 10);
      const st = parseInt(step, 10);
      for (let v = start; v < 60; v += st) out.push(v);
    } else if (part.includes("-")) {
      const [a, b] = part.split("-").map((x) => parseInt(x, 10));
      for (let v = a; v <= b; v++) out.push(v);
    } else {
      out.push(parseInt(part, 10));
    }
  }
  return out;
}

/** "0 * * * *" → "Every hour at :00" · "every 5 min" → "Every 5 minutes" · "0 3 * * *" → "Daily at 03:00" */
export function humanizeCron(expr: string | { kind?: string; expr?: string; display?: string } | null | undefined): string {
  if (!expr) return "—";
  const e = typeof expr === "string" ? expr : expr?.display ?? expr?.expr ?? "";
  if (!e) return "—";
  // Already humanized (interval shorthand like "every 15m" / "every 2h").
  const interval = e.trim().match(/^every (\d+)(m|h|d)$/i);
  if (interval) {
    const n = interval[1];
    const unit = interval[2].toLowerCase();
    const label = unit === "m" ? "minute" : unit === "h" ? "hour" : "day";
    return `Every ${n} ${label}${n === "1" ? "" : "s"}`;
  }
  const parts = e.trim().split(/\s+/);
  if (parts.length !== 5) return e;

  const [min, hour, dom, mon, dow] = parts;
  const mins = parseField(min);
  const hours = parseField(hour);
  const doms = parseField(dom);
  const mons = parseField(mon);
  const dows = parseField(dow);

  // Every N minutes
  if (min.startsWith("*/") && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return `Every ${min.slice(2)} minutes`;
  }
  // Every N hours
  if (hour.startsWith("*/") && min === "0" && dom === "*" && mon === "*" && dow === "*") {
    return `Every ${hour.slice(2)} hours`;
  }
  // Every hour
  if (min === "0" && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return "Every hour";
  }
  // Daily at HH:MM
  if (dom === "*" && mon === "*" && dow === "*" && hours && hours.length === 1 && mins && mins.length === 1) {
    return `Daily at ${fmtTime(hours[0], mins[0])}`;
  }
  // Weekly on specific days
  if (dom === "*" && mon === "*" && dows && dows.length > 0 && dows.length < 7 && hours && hours.length === 1 && mins && mins.length === 1) {
    const dayNames = dows.map((d) => DAYS[d % 7]).join(", ");
    return `${dayNames} at ${fmtTime(hours[0], mins[0])}`;
  }
  // Every N days (dom */2)
  if (dom.startsWith("*/") && mon === "*" && dow === "*" && hours && hours.length === 1 && mins && mins.length === 1) {
    return `Every ${dom.slice(2)} days at ${fmtTime(hours[0], mins[0])}`;
  }
  // Monthly on day X
  if (doms && doms.length === 1 && mon === "*" && dow === "*" && hours && hours.length === 1 && mins && mins.length === 1) {
    return `Monthly on the ${doms[0]}${["st", "nd", "rd", "th"][Math.min(doms[0] % 10 - 1, 3)]} at ${fmtTime(hours[0], mins[0])}`;
  }
  // Specific month (e.g. every 2 months)
  if (mon.startsWith("*/") && dom === "*" && dow === "*" && hours && hours.length === 1 && mins && mins.length === 1) {
    return `Every ${mon.slice(2)} months on the 1st at ${fmtTime(hours[0], mins[0])}`;
  }
  // Fallback: keep the raw expression but strip nothing — better than nothing.
  return e;
}

/** "discord:#akhils-agenticbiz" → "Discord · #akhils-agenticbiz" · "local" → "Local only" · "origin" → "Origin chat" */
export function humanizeDeliver(deliver: string | null | undefined): { label: string; kind: "discord" | "local" | "origin" | "other" } {
  const d = (deliver ?? "local").trim();
  if (d === "local") return { label: "Local only", kind: "local" };
  if (d === "origin") return { label: "Origin chat", kind: "origin" };
  if (d.startsWith("discord:")) {
    const target = d.slice("discord:".length);
    if (target.startsWith("#")) return { label: `Discord · ${target}`, kind: "discord" };
    return { label: `Discord · channel ${target.slice(0, 8)}…`, kind: "discord" };
  }
  if (d.startsWith("telegram:")) return { label: `Telegram · ${d.slice(9)}`, kind: "other" };
  if (d.startsWith("sms:")) return { label: `SMS · ${d.slice(4)}`, kind: "other" };
  if (d.startsWith("whatsapp:")) return { label: `WhatsApp · ${d.slice(9)}`, kind: "other" };
  return { label: d, kind: "other" };
}
