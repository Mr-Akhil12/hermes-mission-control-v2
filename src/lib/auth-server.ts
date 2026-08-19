import { createHash, createHmac, timingSafeEqual } from "crypto";

const TURSO_URL = process.env.TURSO_URL ?? "";
const TURSO_TOKEN = process.env.TURSO_TOKEN ?? "";
const SESSION_COOKIE = "hermesos.session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

async function tursoQuery(sql: string, args: unknown[] = []): Promise<Record<string, unknown>[]> {
  const body = JSON.stringify({
    requests: [
      {
        type: "execute",
        stmt: { sql, args: args.map((v) => ({ type: "text", value: String(v) })) },
      },
    ],
  });
  const res = await fetch(`${TURSO_URL}/v2/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TURSO_TOKEN}`, "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(8000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`turso ${res.status}`);
  const data = await res.json();
  const result = data?.results?.[0]?.response?.result;
  if (!result) return [];
  const cols = result.cols.map((c: { name: string }) => c.name);
  return result.rows.map((row: unknown[]) =>
    Object.fromEntries(row.map((v, i) => [cols[i], (v as { value?: unknown })?.value]))
  );
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function verifyPinServer(pin: string): Promise<boolean> {
  const candidate = sha256Hex(`hermes-os:${pin}:v1`);
  if (TURSO_URL && TURSO_TOKEN) {
    try {
      const rows = await tursoQuery("SELECT value FROM app_settings WHERE key = 'pin_hash' LIMIT 1");
      if (rows.length > 0 && typeof rows[0].value === "string") {
        return constantTimeEqual(candidate, rows[0].value);
      }
    } catch {
      // Turso unreachable — fall through to env hash.
    }
  }
  const envHash = process.env.AUTH_PIN_HASH ?? "";
  if (!envHash) return false;
  return constantTimeEqual(candidate, envHash);
}

export function signSessionToken(): string {
  const secret = process.env.AUTH_SESSION_SECRET ?? "";
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS, v: 1 })).toString("base64url");
  const hmac = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${hmac}`;
}

export function verifySessionToken(token: string): boolean {
  const secret = process.env.AUTH_SESSION_SECRET ?? "";
  if (!secret) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof data.exp === "number" && data.exp > Date.now();
  } catch {
    return false;
  }
}

export { SESSION_COOKIE };
