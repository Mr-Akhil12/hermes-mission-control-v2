/** Shared Turso helpers for the Yellow / trading surface. */

const TURSO_URL = process.env.TURSO_URL ?? "";
const TURSO_TOKEN = process.env.TURSO_TOKEN ?? "";

export function tursoConfigured(): boolean {
  return Boolean(TURSO_URL && TURSO_TOKEN);
}

function argValue(v: unknown): { type: string; value: unknown } {
  if (v == null) return { type: "null", value: null };
  if (typeof v === "number") {
    return Number.isInteger(v)
      ? { type: "integer", value: String(v) }
      : { type: "float", value: v };
  }
  if (typeof v === "boolean") return { type: "integer", value: v ? "1" : "0" };
  return { type: "text", value: String(v) };
}

export async function tursoQuery(sql: string, args: unknown[] = []): Promise<Record<string, unknown>[]> {
  if (!tursoConfigured()) throw new Error("Turso not configured");
  const body = JSON.stringify({
    requests: [
      {
        type: "execute",
        stmt: { sql, args: args.map(argValue) },
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
  return result.rows.map((row: { value?: unknown }[]) =>
    Object.fromEntries(row.map((v, i) => [cols[i], v?.value]))
  );
}

/** Run SQL; ignore "duplicate column" style errors for optional ALTERs. */
export async function tursoExecIgnoreDup(sql: string, args: unknown[] = []): Promise<void> {
  try {
    await tursoQuery(sql, args);
  } catch (e) {
    const msg = String(e);
    if (/duplicate column|already exists/i.test(msg)) return;
    throw e;
  }
}
