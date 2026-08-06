import { NextResponse } from "next/server";
import { fetchState } from "@/lib/data";

export async function GET() {
  const data = await fetchState("runs");
  return NextResponse.json(data);
}
