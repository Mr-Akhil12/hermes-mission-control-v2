import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next.js 16 dev safety gate: allow localhost + LAN origins so client JS
  // hydrates when the dashboard is served over Tailscale/LAN (e.g. :3100).
  allowedDevOrigins: ["127.0.0.1", "localhost", "100.109.86.13"],
};

export default nextConfig;
