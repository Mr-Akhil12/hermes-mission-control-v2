import { NextResponse } from "next/server";
import { fetchState } from "@/lib/data";

export async function GET() {
  const data = await fetchState("artifacts");
  return NextResponse.json(data);
}
