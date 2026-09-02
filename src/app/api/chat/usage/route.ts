// Usage analytics: GET /api/chat/usage?provider=ollama-cloud&bucket=day|week|month
// Reads the gateway's session_model_usage table (ground truth — written by the
// agent core after every API call) and aggregates token in/out + request
// counts per bucket. Cost uses Ollama Cloud metered prices when the provider
// matches (per-M: input / cached-input / output), else falls back to
// estimated_cost_usd sums.

import { NextRequest, NextResponse } from "next/server";
import { bridgeFetch } from "@/lib/bridge";

const OLLAMA_PRICES: Record<string, [number, number, number]> = {
  // model prefix: [in $/M, cached-in $/M, out $/M] (ollama.com pricing)
  "glm-5.3-flash": [0.15, 0.03, 0.5],
  "glm-5.3": [1.4, 0.26, 4.4],
  "glm-5.2": [1.4, 0.26, 4.4],
  "glm-5.1": [1.0, 0.2, 3.2],
  "deepseek-v4-flash": [0.44, 0.014, 1.32],
  "deepseek-v4-pro": [1.32, 0.044, 3.96],
  "gemma4": [0.14, 0.05, 0.4],
  "gpt-oss:120b": [0.15, 0.014, 0.6],
  "gpt-oss:20b": [0.07, 0.035, 0.3],
  "nemotron-3-super": [0.015, 0.015, 0.6],
  "nemotron-3-ultra": [0.1, 0.1, 3.0],
  "kimi-k3": [3.0, 0.3, 15.0],
  "qwen3.5:397b": [0.6, 0.6, 3.6],
};

function priceFor(model: string): [number, number, number] {
  const m = model.toLowerCase();
  for (const key of Object.keys(OLLAMA_PRICES)) {
    if (m.startsWith(key)) return OLLAMA_PRICES[key];
  }
  return [0.15, 0.03, 0.5]; // glm-5.3-flash default — Akhil's dominant model
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const provider = (searchParams.get("provider") || "ollama-cloud").trim();
  const bucket = (searchParams.get("bucket") || "day").trim(); // day|week|month|custom
  const days = Math.min(Math.max(parseInt(searchParams.get("days") || "90", 10) || 90, 1), 400);
  const from = searchParams.get("from") || "";
  const to = searchParams.get("to") || "";

  const qs = new URLSearchParams({ provider, bucket, days: String(days) });
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);

  const resp = await bridgeFetch(`/api/usage?${qs.toString()}`, { method: "GET" });
  const data = await resp.json().catch(() => ({ error: "usage upstream failed" }));
  return new Response(JSON.stringify(data), {
    status: resp.status,
    headers: { "Content-Type": "application/json" },
  });
}