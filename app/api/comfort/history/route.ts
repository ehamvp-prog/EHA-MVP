// =====================================================================
// GET /api/comfort/history
// Read-only. Returns a time series of INDOOR TEMPERATURE, COMFORT SCORE,
// and HAPPY NUMBER, bucketed by hour (today) and day (last ~31 days),
// mirroring /api/cost/history. COMFORT SCORE is derived per bucket from the
// stored indoor temp/humidity via the unified elevateComfort model. HAPPY
// NUMBER is the household fingerprint (the band's width+centrality score) — a
// flat reference line, never derived from telemetry. Changes no data.
// =====================================================================

import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { SITE_ID } from "@/lib/compute-reading"
import { comfortContext, loadComfortModel, deriveBandCached } from "@/lib/comfort/load"
import { scoreAgainstBand, type ComfortBand } from "@/lib/comfort/model"
import { chicagoMonthIndex } from "@/lib/chicago-time"

export const dynamic = "force-dynamic"

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

    // Derive the household band ONCE for "now". The Happy Number is a property
    // of the band (household fingerprint), independent of telemetry and of the
    // sleep overlay, so it's drawn as a flat reference across every bucket.
    // Scoring is against the BASELINE band (night=false) so the comfort series
    // stays comparable across the whole day without a nightly sawtooth.
    const nowMonth = chicagoMonthIndex()
    const baseCtx = { month: nowMonth, blower_on: false, night: false }
    const { inputs, band: nowBand } = await loadComfortModel(supabase, SITE_ID, baseCtx)
    const happyConstant = nowBand.happyNumber

    // Comfort Score's clothing assumption is seasonal, so the daily series may
    // span months — derive (memoized) a baseline band per distinct month.
    const bandForMonth = (month0: number): ComfortBand =>
      month0 === nowMonth ? nowBand : deriveBandCached(inputs, { month: month0, blower_on: false, night: false })

    const [daily, hourly] = await Promise.all([
      supabase.rpc("daily_indoor_history", { p_site_id: SITE_ID, p_days: 31 }),
      supabase.rpc("hourly_indoor_today", { p_site_id: SITE_ID }),
    ])
    if (daily.error) throw daily.error
    if (hourly.error) throw hourly.error

    const days = ((daily.data ?? []) as DayRow[])
      .map((r) => {
        const tempF = r.avg_temp_f == null ? null : Number(r.avg_temp_f)
        const rh = r.avg_rh == null ? null : Number(r.avg_rh)
        if (tempF == null || rh == null) return null
        const month0 = monthOfDay(String(r.day))
        const b = bandForMonth(month0)
        const { score } = scoreAgainstBand(tempF, rh, b, inputs, { month: month0, blower_on: false, night: false })
        return { day: String(r.day), tempF: Math.round(tempF * 10) / 10, comfort: score, happy: happyConstant }
      })
      .filter((d): d is { day: string; tempF: number; comfort: number; happy: number } => d !== null)

    const hours = ((hourly.data ?? []) as HourRow[])
      .map((r) => {
        const tempF = r.avg_temp_f == null ? null : Number(r.avg_temp_f)
        const rh = r.avg_rh == null ? null : Number(r.avg_rh)
        if (tempF == null || rh == null) return null
        const { score } = scoreAgainstBand(tempF, rh, nowBand, inputs, baseCtx)
        return { hour: Number(r.hour), tempF: Math.round(tempF * 10) / 10, comfort: score, happy: happyConstant }
      })
      .filter((h): h is { hour: number; tempF: number; comfort: number; happy: number } => h !== null)

    return NextResponse.json({ ok: true, days, hours })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
