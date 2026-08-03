// =====================================================================
// GET /api/comfort/history
// Read-only. Returns a time series of INDOOR TEMPERATURE, COMFORT SCORE,
// and HAPPY NUMBER, bucketed by hour (today) and day (last ~31 days),
// mirroring /api/cost/history. COMFORT SCORE is derived per bucket from the
// stored indoor temp/humidity (the same math the live ring uses). HAPPY NUMBER
// is the user's TARGET comfort computed from their saved profile preferences —
// a flat reference line, never derived from telemetry. Changes no data.
// =====================================================================

import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { SITE_ID } from "@/lib/compute-reading"
import { type ComfortProfile } from "@/lib/comfort/happy-number"
import { comfortFromConditions } from "@/lib/comfort/ring"
import { chicagoMonthIndex } from "@/lib/chicago-time"

export const dynamic = "force-dynamic"

// Sensible defaults when no comfort profile has been saved yet — matches the
// app's standing defaults so derived scores line up with the live ring.
const DEFAULT_PROFILE: ComfortProfile = {
  preferred_temp_f: 72,
  preferred_rh: 45,
  age_group: "adults",
  activity_level: "moderate",
  household_size: 2,
  health_considerations: [],
}

// Month (0–11) in Central time for a given YYYY-MM-DD day key.
function monthOfDay(dayIso: string): number {
  const m = Number(dayIso.slice(5, 7))
  return Number.isFinite(m) ? m - 1 : chicagoMonthIndex()
}

type DayRow = { day: string; avg_temp_f: number | string | null; avg_rh: number | string | null }
type HourRow = { hour: number; avg_temp_f: number | string | null; avg_rh: number | string | null }

export async function GET() {
  try {
    const supabase = createAdminClient()

    // Load the saved comfort profile (or fall back to defaults).
    const { data: profileRow } = await supabase
      .from("comfort_profile")
      .select("*")
      .eq("site_id", SITE_ID)
      .maybeSingle()
    const profile: ComfortProfile = profileRow
      ? {
          preferred_temp_f: Number(profileRow.preferred_temp_f ?? DEFAULT_PROFILE.preferred_temp_f),
          preferred_rh: Number(profileRow.preferred_rh ?? DEFAULT_PROFILE.preferred_rh),
          age_group: profileRow.age_group ?? DEFAULT_PROFILE.age_group,
          activity_level: profileRow.activity_level ?? DEFAULT_PROFILE.activity_level,
          household_size: Number(profileRow.household_size ?? DEFAULT_PROFILE.household_size),
          health_considerations: Array.isArray(profileRow.health_considerations)
            ? profileRow.health_considerations
            : [],
        }
      : DEFAULT_PROFILE

    const [daily, hourly] = await Promise.all([
      supabase.rpc("daily_indoor_history", { p_site_id: SITE_ID, p_days: 31 }),
      supabase.rpc("hourly_indoor_today", { p_site_id: SITE_ID }),
    ])
    if (daily.error) throw daily.error
    if (hourly.error) throw hourly.error

    // Happy Number is a STORED property of the comfort profile — the pure
    // comfort of the user's preferred conditions. Compute it ONCE (exactly as
    // the Comfort Profile settings screen does: comfortFromConditions at the
    // current month) and draw it as a flat reference line across every bucket.
    // It never comes from telemetry, so it can't shadow the Comfort Score.
    const nowMonth = chicagoMonthIndex()
    const happyConstant = comfortFromConditions(
      profile.preferred_temp_f,
      profile.preferred_rh,
      profile,
      nowMonth,
    )

    const days = ((daily.data ?? []) as DayRow[])
      .map((r) => {
        const tempF = r.avg_temp_f == null ? null : Number(r.avg_temp_f)
        const rh = r.avg_rh == null ? null : Number(r.avg_rh)
        if (tempF == null || rh == null) return null
        // Comfort Score stays per-day (its clothing assumption is seasonal).
        const comfort = comfortFromConditions(tempF, rh, profile, monthOfDay(String(r.day)))
        return { day: String(r.day), tempF: Math.round(tempF * 10) / 10, comfort, happy: happyConstant }
      })
      .filter((d): d is { day: string; tempF: number; comfort: number; happy: number } => d !== null)

    const hours = ((hourly.data ?? []) as HourRow[])
      .map((r) => {
        const tempF = r.avg_temp_f == null ? null : Number(r.avg_temp_f)
        const rh = r.avg_rh == null ? null : Number(r.avg_rh)
        if (tempF == null || rh == null) return null
        const comfort = comfortFromConditions(tempF, rh, profile, nowMonth)
        return { hour: Number(r.hour), tempF: Math.round(tempF * 10) / 10, comfort, happy: happyConstant }
      })
      .filter((h): h is { hour: number; tempF: number; comfort: number; happy: number } => h !== null)

    return NextResponse.json({ ok: true, days, hours })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
