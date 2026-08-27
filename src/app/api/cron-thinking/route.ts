import { NextResponse } from "next/server";
import { existsSync } from "fs";
import os from "os";
import path from "path";
import { DatabaseSync } from "node:sqlite";

const HERMES_HOME = process.env.HERMES_HOME ?? path.join(os.homedir(), ".hermes");
const STATE_DB = path.join(HERMES_HOME, "state.db");

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const job = searchParams.get("job");
    const execution = searchParams.get("execution");

    if (!job) return NextResponse.json({ error: "job param required" }, { status: 400 });
    if (!existsSync(STATE_DB)) return NextResponse.json({ error: "state.db missing" }, { status: 404 });

    const db = new DatabaseSync(STATE_DB, { readOnly: true });

    // Find the most recent cron session for this job
    let sessionId: string | undefined;
    if (execution) {
      const row = db
        .prepare("SELECT id FROM sessions WHERE id = ?")
        .get(execution) as { id: string } | undefined;
      if (row) sessionId = row.id;
    }
    if (!sessionId) {
      const row = db
        .prepare(
          "SELECT id FROM sessions WHERE id LIKE ? ORDER BY started_at DESC LIMIT 1"
        )
        .get(`cron_${job}_%`) as { id: string } | undefined;
      if (row) sessionId = row.id;
    }

    if (!sessionId) {
      db.close();
      return NextResponse.json({ error: "no session found" }, { status: 404 });
    }

    // Pull the transcript: prompt (system+user) and messages
    const messages = db
      .prepare(
        "SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 80"
      )
      .all(sessionId) as { role: string; content: string }[];

    const promptMsg = messages.find(
      (m) => m.role === "user" && m.content.includes("scheduled cron job")
    );

    db.close();

    return NextResponse.json({
      session_id: sessionId,
      prompt: promptMsg?.content ?? "",
      messages: messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          role: m.role,
          content:
            typeof m.content === "string"
              ? m.content.slice(0, 4000)
              : JSON.stringify(m.content).slice(0, 4000),
        })),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
