import { NextResponse } from "next/server";

// Session probe — the proxy.ts gate already 401s this route when the
// hermesos.session cookie is missing/invalid, so reaching here means the
// session is valid. The client uses this to decide whether the app is
// truly unlocked (not just locally flagged).
export async function GET() {
  return NextResponse.json({ ok: true });
}
