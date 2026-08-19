import { NextResponse } from "next/server";
import { verifyPinServer, signSessionToken, SESSION_COOKIE } from "@/lib/auth-server";

export async function POST(request: Request) {
  if (!process.env.AUTH_PIN_HASH) {
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }
  let pin = "";
  try {
    const body = await request.json();
    pin = typeof body?.pin === "string" ? body.pin : "";
  } catch {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const ok = await verifyPinServer(pin);
  if (!ok) return NextResponse.json({ ok: false }, { status: 401 });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, signSessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 12 * 60 * 60,
  });
  return res;
}
