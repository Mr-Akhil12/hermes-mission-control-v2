import { NextRequest, NextResponse } from "next/server";
import { bridgeFetch } from "@/lib/bridge";

// GET /api/chat/profiles — live multiplex profile list from the state server
// (~/.hermes/profiles/ dirs + gateway allowlist). Powers the chat profile
// dropdown and the Agents screen, so a profile created via
// `hermes profile create` appears automatically — no hardcoded list.

export async function GET(_request: NextRequest) {
  try {
    const resp = await bridgeFetch("/api/profiles", { cache: "no-store" });
    const data = await resp.json();
    return NextResponse.json(data, { status: resp.status });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

// NOTE: the state server response also carries `default_model` — the
// gateway's live config.yaml model.default. The chat page uses it to pin
// new sessions to the real brain instead of a hardcoded model name.
