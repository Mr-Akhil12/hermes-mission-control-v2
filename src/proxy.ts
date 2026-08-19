import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { SESSION_COOKIE } from "@/lib/auth-server";

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "SAMEORIGIN",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

const PUBLIC_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/verify",
  "/api/push/vapid",
  "/api/health",
]);

const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 10;
const rateMap = new Map<string, { count: number; windowStart: number }>();

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return "unknown";
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    rateMap.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_MAX;
}

function sessionValid(req: NextRequest): boolean {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return false;
  const secret = process.env.AUTH_SESSION_SECRET ?? "";
  if (!secret) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof data.exp === "number" && data.exp > Date.now();
  } catch {
    return false;
  }
}

function withSecurityHeaders(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    res.headers.set(k, v);
  }
  return res;
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathname.startsWith("/api/")) {
    const isPublic = PUBLIC_PATHS.has(pathname);
    if (pathname === "/api/auth/login" || pathname === "/api/auth/verify") {
      if (rateLimited(clientIp(req))) {
        return withSecurityHeaders(NextResponse.json({ error: "rate limited" }, { status: 429 }));
      }
    }
    if (!isPublic && !sessionValid(req)) {
      return withSecurityHeaders(NextResponse.json({ error: "unauthorized" }, { status: 401 }));
    }
  }

  // The native dashboard proxy is a full Hermes surface — require our session
  // cookie so it can't be reached without unlocking the dashboard first.
  if (pathname.startsWith("/native-proxy") && !sessionValid(req)) {
    return withSecurityHeaders(NextResponse.json({ error: "unauthorized" }, { status: 401 }));
  }

  return withSecurityHeaders(NextResponse.next());
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|woff2?|css|js|map)$).*)"],
};
