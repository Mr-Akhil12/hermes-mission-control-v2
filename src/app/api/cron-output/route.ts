import { NextRequest, NextResponse } from "next/server";
import { bridgeFetch } from "@/lib/bridge";

// Cron output: proxy file listings and file contents from the local state server.
export async function GET(request: NextRequest) {
  try {
    const params = new URLSearchParams();
    const job = request.nextUrl.searchParams.get("job");
    const file = request.nextUrl.searchParams.get("file");

    if (job !== null) params.set("job", job);
    if (file !== null) params.set("file", file);

    const query = params.toString();
    const resp = await bridgeFetch(`/api/cron-output${query ? `?${query}` : ""}`, {
      cache: "no-store",
    });
    const data = await resp.json();
    return NextResponse.json(data, { status: resp.status });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
