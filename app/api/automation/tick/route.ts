import { NextResponse } from "next/server"
import { runAutomationTick } from "@/lib/automation/engine"
import { ingestWeather } from "@/lib/weather-ingest"

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
    // Run the automation engine and a rolling weather self-heal together. The
    // weather ingest keeps weather_observations current going forward (and
    // backfills any recent gap) on the same 5-minute cron, independent of
    // whether any automation is enabled. A weather failure never fails the tick.
    const [result, weather] = await Promise.all([
      runAutomationTick(),
      ingestWeather().catch((err) => ({
        ok: false as const,
        error: err instanceof Error ? err.message : "weather ingest failed",
      })),
    ])
    if (!weather.ok) console.log("[v0] weather ingest (tick) skipped:", weather.error)
    return NextResponse.json({ ok: true, ...result, weather })
  } catch (err) {
    console.log("[v0] automation tick failed:", err instanceof Error ? err.message : err)
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "tick failed" },
      { status: 500 },
    )
  }
}
