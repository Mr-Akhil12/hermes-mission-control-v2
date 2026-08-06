import { NextRequest, NextResponse } from "next/server";

// Same-origin proxy for the native Hermes dashboard.
// The iframe loads /native-proxy/* on the Vercel domain; this route fetches
// the real dashboard from the Tailscale funnel and rewrites absolute paths
// (/assets, /api, /auth, /fonts) to stay inside /native-proxy so cookies
// become first-party and the SPA's hardcoded basename "/" still works.
const FUNNEL = process.env.NEXT_PUBLIC_FUNNEL_URL ?? "https://akhils-pc.tail6d629e.ts.net";
const PREFIX = "/native-proxy";

// Paths that must be rewritten inside HTML/JS so the SPA stays same-origin.
const REWRITES: [RegExp, string][] = [
  [/\/assets\//g, `${PREFIX}/assets/`],
  [/\/fonts\//g, `${PREFIX}/fonts/`],
  [/\/api\//g, `${PREFIX}/api/`],
  [/\/auth\//g, `${PREFIX}/auth/`],
  [/\/favicon\.ico/g, `${PREFIX}/favicon.ico`],
];

function rewriteBody(body: string): string {
  let out = body;
  for (const [re, to] of REWRITES) out = out.replace(re, to);
  return out;
}

export async function handler(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  const pathname = path.length ? `/${path.join("/")}` : "/";
  const search = request.nextUrl.search;
  const target = `${FUNNEL}${pathname}${search}`;

  try {
    // Forward method, body, and cookies (first-party now, so they pass through).
    const headers = new Headers();
    const cookie = request.headers.get("cookie");
    if (cookie) headers.set("cookie", cookie);
    const contentType = request.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);

    const init: RequestInit = {
      method: request.method,
      headers,
      cache: "no-store",
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = await request.arrayBuffer();
    }

    const resp = await fetch(target, init);
    const respHeaders = new Headers();
    const ctype = resp.headers.get("content-type") ?? "";

    // Forward Set-Cookie so the session cookie lands on the Vercel origin.
    const setCookies = resp.headers.getSetCookie?.() ?? [];
    for (const sc of setCookies) {
      respHeaders.append("set-cookie", sc.replace(/; ?Path=\//i, "; Path=/"));
    }

    // Rewrite HTML (login page + SPA shell) and JS bundles.
    if (ctype.includes("text/html")) {
      const text = await resp.text();
      let out = rewriteBody(text);
      // Inject the base-path hook BEFORE the SPA bundle runs.
      out = out.replace(
        "<head>",
        `<head><script>window.__HERMES_BASE_PATH__='${PREFIX}';</script>`
      );
      respHeaders.set("content-type", "text/html; charset=utf-8");
      return new NextResponse(out, { status: resp.status, headers: respHeaders });
    }

    if (ctype.includes("javascript") || pathname.endsWith(".js")) {
      const text = await resp.text();
      let out = rewriteBody(text);
      // The SPA hardcodes router basename "/" — point it at the proxy prefix so
      // client-side navigation and full reloads both stay inside /native-proxy.
      out = out.replace(/basename:e=`\/`/g, `basename:e='${PREFIX}'`);
      respHeaders.set("content-type", ctype);
      return new NextResponse(out, { status: resp.status, headers: respHeaders });
    }

    // JSON: rewrite the login response's `next` so the iframe stays proxied.
    if (ctype.includes("application/json")) {
      const text = await resp.text();
      let out = text;
      try {
        const json = JSON.parse(text);
        if (json && typeof json.next === "string" && json.next.startsWith("/")) {
          json.next = `${PREFIX}${json.next === "/" ? "" : json.next}`;
          out = JSON.stringify(json);
        }
      } catch {
        // not JSON — pass through
      }
      respHeaders.set("content-type", ctype);
      return new NextResponse(out, { status: resp.status, headers: respHeaders });
    }

    // Everything else (CSS, fonts, images, uploads): stream through.
    const buf = await resp.arrayBuffer();
    if (ctype) respHeaders.set("content-type", ctype);
    return new NextResponse(new Uint8Array(buf), {
      status: resp.status,
      headers: respHeaders,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `native proxy failed: ${String(e)}` },
      { status: 502 }
    );
  }
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
