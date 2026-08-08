import { NextResponse } from "next/server";
import { fetchState } from "@/lib/data";

export async function GET() {
  // No limit — the home hero + cron monitor need the FULL job list
  // (36 jobs). fetchState's default 25 cut real counts.
  const data = await fetchState("crons", 500);
  return NextResponse.json(data);
}
