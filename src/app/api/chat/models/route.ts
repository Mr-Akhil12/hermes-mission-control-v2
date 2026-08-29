import { NextResponse } from "next/server";
import { bridgeFetch } from "@/lib/bridge";

// Dynamic model inventory: GET /api/chat/models?refresh=1
//
// Proxies the Hermes API's /api/model/options through the state server
// bridge. Returns the user's real provider+model inventory derived from
// config.yaml (providers with valid keys) plus live custom-provider
// catalogs — so the /model picker can never offer an invalid model.
// `refresh=1` re-probes every custom provider's live model list.

export async function GET(request: Request) {
  const url = new URL(request.url);
  const refresh = url.searchParams.get("refresh") === "1";
  try {
    const resp = await bridgeFetch(
      `/api/model/options${refresh ? "?refresh=1" : ""}`,
      { cache: "no-store" },
    );
    const data = await resp.json().catch(() => ({}));
    return NextResponse.json(data, { status: resp.status });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}