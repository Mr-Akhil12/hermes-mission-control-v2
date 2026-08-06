import { NextResponse } from "next/server";
import { existsSync } from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";

const STATE_DB = path.join(os.homedir(), ".hermes", "state.db");

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(Number(searchParams.get("limit") ?? "25"), 100);
    if (!existsSync(STATE_DB)) return NextResponse.json({ sessions: [], source: "missing" });

    const db = new Database(STATE_DB, { readonly: true });
    const rows = db
      .prepare(
        `SELECT id, source, title, started_at, ended_at, end_reason, message_count, tool_call_count, input_tokens, output_tokens
         FROM sessions
         ORDER BY started_at DESC
         LIMIT ?`
      )
      .all(limit) as Record<string, unknown>[];

    // Attach last message preview per session (bounded)
    const sessions = rows.map((r) => {
      let lastMessage: string | null = null;
      try {
        const m = db
          .prepare("SELECT content FROM messages WHERE session_id = ? AND role = 'assistant' AND content != '' ORDER BY id DESC LIMIT 1")
          .get(r.id as string) as { content: string } | undefined;
        if (m) lastMessage = m.content.slice(0, 200);
      } catch {
        lastMessage = null;
      }
      return { ...r, last_message: lastMessage };
    });
    db.close();

    return NextResponse.json({ sessions, source: "local" });
  } catch (e) {
    return NextResponse.json({ error: String(e), sessions: [] }, { status: 500 });
  }
}
