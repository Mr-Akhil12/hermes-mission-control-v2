import { NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";
import os from "os";
import path from "path";

const JOBS_PATH = path.join(os.homedir(), ".hermes", "cron", "jobs.json");

export async function GET() {
  try {
    if (!existsSync(JOBS_PATH)) {
      return NextResponse.json({ jobs: [], source: "missing" });
    }
    const raw = readFileSync(JOBS_PATH, "utf8");
    const data = JSON.parse(raw);
    const jobs = Array.isArray(data) ? data : data.jobs ?? [];
    return NextResponse.json({ jobs, source: "local" });
  } catch (e) {
    return NextResponse.json({ error: String(e), jobs: [] }, { status: 500 });
  }
}
