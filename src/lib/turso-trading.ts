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

/**
 * Run statements as ONE atomic Hrana batch: BEGIN, then each step only runs if
 * the previous step succeeded, COMMIT only if all succeeded, otherwise ROLLBACK.
 * Throws if any step failed or was skipped. Returns rows/affected per input stmt.
 */
export async function tursoBatch(
  stmts: { sql: string; args?: unknown[] }[]
): Promise<{ rows: Record<string, unknown>[]; affected: number }[]> {
  if (!tursoConfigured()) throw new Error("Turso not configured");
  type Cond = Record<string, unknown> | null;
  const steps: { condition: Cond; stmt: { sql: string; args: unknown[] } }[] = [];
  steps.push({ condition: null, stmt: { sql: "BEGIN", args: [] } });
  stmts.forEach((s) => {
    steps.push({
      condition: { type: "ok", step: steps.length - 1 },
      stmt: { sql: s.sql, args: (s.args ?? []).map(argValue) },
    });
  });
  const commitIdx = steps.length;
  steps.push({ condition: { type: "ok", step: commitIdx - 1 }, stmt: { sql: "COMMIT", args: [] } });
  steps.push({
    condition: { type: "not", cond: { type: "ok", step: commitIdx } },
    stmt: { sql: "ROLLBACK", args: [] },
  });

  const body = JSON.stringify({
    requests: [{ type: "batch", batch: { steps } }, { type: "close" }],
  });
  const res = await fetch(`${TURSO_URL}/v2/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TURSO_TOKEN}`, "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(15000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`turso ${res.status}`);
  const data = await res.json();
  const top = data?.results?.[0];
  if (top?.type !== "ok") throw new Error(`turso batch failed: ${top?.error?.message ?? "unknown"}`);
  const br = top.response?.result as {
    step_results: ({ cols: { name: string }[]; rows: { value?: unknown }[][]; affected_row_count?: number } | null)[];
    step_errors: ({ message?: string } | null)[];
  };
  const firstErr = br.step_errors.findIndex((e) => e != null);
  if (firstErr >= 0) {
    throw new Error(`step ${firstErr} failed (rolled back): ${br.step_errors[firstErr]?.message ?? "unknown"}`);
  }
  if (br.step_results[commitIdx] == null) throw new Error("commit did not run (rolled back)");
  return stmts.map((_, i) => {
    const r = br.step_results[i + 1];
    if (!r) return { rows: [], affected: 0 };
    const cols = r.cols.map((c) => c.name);
    return {
      rows: r.rows.map((row) => Object.fromEntries(row.map((v, j) => [cols[j], v?.value]))),
      affected: Number(r.affected_row_count ?? 0),
    };
  });
}
