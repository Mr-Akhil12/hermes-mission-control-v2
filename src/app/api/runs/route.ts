import { NextResponse } from "next/server";
import { existsSync } from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";

const EXEC_PATH = path.join(os.homedir(), ".hermes", "cron", "executions.db");

export async function GET() {
  try {
    if (!existsSync(EXEC_PATH)) {
      return NextResponse.json({ runs: [], source: "missing" });
    }
    const db = new Database(EXEC_PATH, { readonly: true });
    const rows = db
      .prepare(
        "SELECT job_id, status, claimed_at, finished_at, error FROM executions WHERE claimed_at > datetime('now','-25 hours') ORDER BY claimed_at DESC LIMIT 500"
      )
      .all();
    db.close();
    return NextResponse.json({ runs: rows, source: "local" });
  } catch (e) {
    return NextResponse.json({ error: String(e), runs: [] }, { status: 500 });
  }
}
