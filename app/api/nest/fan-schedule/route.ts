// =====================================================================
// /api/nest/fan-schedule
//   GET   the household's fan schedule
//   POST  { schedule: "auto" | "on" | "30" | "15" } — saves it and applies it
//         right away (the 5-minute tick keeps it going after that).
// =====================================================================

import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { SITE_ID } from "@/lib/compute-reading"
import { applyControl, getFreshAccessToken, MAX_FAN_MINUTES, NestRateLimitError } from "@/lib/nest/client"
import { isFanSchedule } from "@/lib/nest/fan-schedule"

export const dynamic = "force-dynamic"

export async function GET() {
  const { data, error } = await createAdminClient()
    .from("system_profile")
    .select("fan_schedule, fan_schedule_last_start")
    .eq("site_id", SITE_ID)
    .maybeSingle()
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({
    ok: true,
    schedule: data?.fan_schedule ?? "auto",
    last_start: data?.fan_schedule_last_start ?? null,
  })
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const schedule = body?.schedule
  if (!isFanSchedule(schedule)) {
    return NextResponse.json({ ok: false, error: "Invalid schedule" }, { status: 400 })
  }
  const db = createAdminClient()
  const now = new Date()

  // Apply now: Auto ends any fan timer; the others start the fan.
  try {
    const token = await getFreshAccessToken()
    if (!token) return NextResponse.json({ ok: false, error: "not_connected" }, { status: 401 })
    if (schedule === "auto") await applyControl(token, { fanMode: "AUTO" })
    else await applyControl(token, { fanMode: "ON", fanMinutes: schedule === "on" ? MAX_FAN_MINUTES : Number(schedule) })
  } catch (err) {
    if (err instanceof NestRateLimitError) {
      return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 })
    }
    return NextResponse.json({ ok: false, error: "nest_control_failed" }, { status: 500 })
  }

  const { error } = await db
    .from("system_profile")
    .update({ fan_schedule: schedule, fan_schedule_last_start: schedule === "auto" ? null : now.toISOString() })
    .eq("site_id", SITE_ID)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, schedule })
}
