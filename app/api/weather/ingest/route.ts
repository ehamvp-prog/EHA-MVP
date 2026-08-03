import { NextResponse } from "next/server"
import { ingestWeather } from "@/lib/weather-ingest"

export const dynamic = "force-dynamic"
export const maxDuration = 60

// =====================================================================
// POST /api/weather/ingest
//
// Fills weather_observations with real NWS station data.
//   • No body  -> rolling self-heal (last 48h).
//   • { from, to } -> historical backfill over an explicit range.
//   • { days: N }  -> rolling backfill for the last N days.
//
// Secured exactly like the automation tick: caller must send
// "Authorization: Bearer <AUTOMATION_TICK_SECRET>".
// =====================================================================

export async function POST(request: Request) {
  const secret = process.env.AUTOMATION_TICK_SECRET
  if (!secret) {
    return NextResponse.json({ ok: false, error: "Server is missing AUTOMATION_TICK_SECRET." }, { status: 500 })
  }
  const provided = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim()
  if (provided !== secret) {
    return NextResponse.json({ ok: false, error: "Unauthorized. Bad or missing Bearer secret." }, { status: 401 })
  }

  try {
    const body = await request.json().catch(() => ({}) as Record<string, unknown>)
    let from = body.from as string | undefined
    let to = body.to as string | undefined
    const days = body.days != null ? Number(body.days) : undefined

    if (!from && !to && days && Number.isFinite(days) && days > 0) {
      to = new Date().toISOString()
      from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
    }

    const result = await ingestWeather({ from, to, siteId: (body.site_id as string) ?? undefined })
    return NextResponse.json(result, { status: result.ok ? 200 : 400 })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "ingest failed" },
      { status: 500 },
    )
  }
}
