import { NextResponse } from "next/server"
import { runHeatingDecode } from "@/lib/heating/decode"

export const dynamic = "force-dynamic"
export const maxDuration = 60

// =====================================================================
// Furnace decode  ->  POST /api/heating/decode
//
// CRON-ONLY. Called every minute by a Supabase pg_cron job so furnace
// cycles are recorded around the clock, app open or not. Secured the same
// way as the automation tick: "Authorization: Bearer <AUTOMATION_TICK_SECRET>".
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
    const result = await runHeatingDecode()
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : "decode failed"
    console.log("[heating] decode failed:", message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
