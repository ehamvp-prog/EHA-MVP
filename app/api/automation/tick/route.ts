import { NextResponse } from "next/server"
import { runAutomationTick } from "@/lib/automation/engine"

export const dynamic = "force-dynamic"
export const maxDuration = 30

// =====================================================================
// Automation tick  ->  POST /api/automation/tick
//
// CRON-ONLY. This endpoint is the single, always-on trigger for the
// automation engine. It is invoked every 5 minutes by a Supabase
// pg_cron job (via pg_net.http_post) so automation runs server-side
// around the clock, whether or not anyone has the app open.
//
// It is secured exactly like the telemetry ingest route: the caller
// must send "Authorization: Bearer <AUTOMATION_TICK_SECRET>". No other
// trigger path exists — the client never calls this.
// =====================================================================

export async function POST(request: Request) {
  const secret = process.env.AUTOMATION_TICK_SECRET
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "Server is missing AUTOMATION_TICK_SECRET." },
      { status: 500 },
    )
  }

  const authHeader = request.headers.get("authorization") ?? ""
  const provided = authHeader.replace(/^Bearer\s+/i, "").trim()
  if (provided !== secret) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized. Bad or missing Bearer secret." },
      { status: 401 },
    )
  }

  try {
    const result = await runAutomationTick()
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    console.log("[v0] automation tick failed:", err instanceof Error ? err.message : err)
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "tick failed" },
      { status: 500 },
    )
  }
}
