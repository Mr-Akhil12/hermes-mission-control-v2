import type { NextConfig } from "next";

const DATA_URL = process.env.NEXT_PUBLIC_DATA_URL ?? "";
const FUNNEL_URL = process.env.NEXT_PUBLIC_FUNNEL_URL ?? "https://akhils-pc.tail6d629e.ts.net";

const nextConfig: NextConfig = {
  // Next.js 16 dev safety gate: allow localhost + LAN origins so client JS
  // hydrates when the dashboard is served over Tailscale/LAN (e.g. :3100).
  allowedDevOrigins: ["127.0.0.1", "localhost", "172.21.184.37"],
  async headers() {
    const connectSrc = ["'self'", "wss:", "https:"];
    if (DATA_URL) connectSrc.push(DATA_URL);
    const frameSrc = ["'self'"];
    if (FUNNEL_URL) frameSrc.push(FUNNEL_URL);
    if (DATA_URL) frameSrc.push(DATA_URL);
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              `connect-src ${connectSrc.join(" ")}`,
              "img-src 'self' data: blob:",
              `frame-src ${frameSrc.join(" ")}`,
              "font-src 'self' data:",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
