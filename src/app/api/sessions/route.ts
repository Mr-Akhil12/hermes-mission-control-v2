import { NextResponse } from "next/server";
import { fetchState } from "@/lib/data";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = Number(searchParams.get("limit") ?? "25");
  const data = await fetchState("sessions", limit);
  return NextResponse.json(data);
}
