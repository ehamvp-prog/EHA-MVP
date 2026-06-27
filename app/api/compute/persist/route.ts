// =====================================================================
// POST /api/compute/persist
// Runs the SAME shared pipeline as /api/compute/live, then writes one
// row to computed_readings at a locked sample interval. Also maintains
// the month-to-date accumulated cost (seeded each month by the Evergy
// $14.25 customer charge) without overbilling for offline gaps.
//
// Intended to be called on a fixed cadence (e.g. a 1-minute cron).
// =====================================================================

import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { computeLiveReading, SITE_ID } from "@/lib/compute-reading"

export const dynamic = "force-dynamic"

// Minimum spacing between persisted rows. Calls that arrive sooner are
// acknowledged but skipped, so the locked interval can't be flooded.
const LOCK_INTERVAL_SEC = 55

// Never bill more than this much wall-clock per interval. Protects the
// accumulator from large jumps after the system/sensors were offline.
const MAX_INTERVAL_HOURS = 0.5

// Evergy Schedule RTOU fixed monthly customer charge.
const MONTHLY_CUSTOMER_CHARGE = 14.25

// CST year-round (no DST), matching the tariff's stated basis.
const CST_OFFSET_MS = 6 * 60 * 60 * 1000

function cstMonthKey(iso: string): string {
  const cst = new Date(new Date(iso).getTime() - CST_OFFSET_MS)
  return `${cst.getUTCFullYear()}-${String(cst.getUTCMonth() + 1).padStart(2, "0")}`
}

export async function POST() {
  try {
    const supabase = createAdminClient()

    // Enforce the locked sample interval using the most recent saved row.
    const { data: lastRows } = await supabase
      .from("computed_readings")
      .select("reading_at, accumulated_cost")
      .eq("site_id", SITE_ID)
      .order("reading_at", { ascending: false })
      .limit(1)

    const last = lastRows?.[0] ?? null
    const now = Date.now()
    if (last) {
      const sinceSec = (now - new Date(last.reading_at).getTime()) / 1000
      if (sinceSec < LOCK_INTERVAL_SEC) {
        return NextResponse.json({
          ok: true,
          persisted: false,
          reason: "locked_interval",
          nextInSec: Math.ceil(LOCK_INTERVAL_SEC - sinceSec),
        })
      }
    }

    const bundle = await computeLiveReading()
    const c = bundle.computed
    const w = bundle.weather

    // --- Month-to-date accumulated cost ---------------------------------
    const thisMonth = cstMonthKey(bundle.readingAt)
    const lastMonth = last ? cstMonthKey(last.reading_at) : null
    const sameMonth = last != null && lastMonth === thisMonth

    // Base: continue this month's total, or seed a new month with the
    // fixed customer charge.
    const base = sameMonth
      ? Number(last!.accumulated_cost ?? 0)
      : MONTHLY_CUSTOMER_CHARGE

    // Energy added since the last row (capped against offline gaps).
    let increment = 0
    if (c.cost_per_hour != null && last) {
      const elapsedHours = Math.min(
        MAX_INTERVAL_HOURS,
        (now - new Date(last.reading_at).getTime()) / 3_600_000,
      )
      // Only accrue within the same month; a fresh month starts clean.
      if (sameMonth) increment = c.cost_per_hour * elapsedHours
    }
    const accumulatedCost = Math.round((base + increment) * 10000) / 10000

    const row = {
      site_id: SITE_ID,
      reading_at: bundle.readingAt,
      return_temp_f: c.return_temp_f,
      return_rh: c.return_rh,
      supply_temp_f: c.supply_temp_f,
      supply_rh: c.supply_rh,
      static_pressure_inwc: c.static_pressure_inwc,
      condenser_watts_leg1: c.condenser_watts_leg1,
      condenser_watts_leg2: c.condenser_watts_leg2,
      blower_watts: c.blower_watts,
      airflow_cfm: c.airflow_cfm,
      airflow_confidence: c.airflow_confidence,
      return_enthalpy: c.return_enthalpy,
      supply_enthalpy: c.supply_enthalpy,
      capacity_btuh: c.capacity_btuh,
      total_watts: c.total_watts,
      live_eer: c.live_eer,
      measured_seer2_estimate: c.measured_seer2_estimate,
      season: c.tou_season,
      tou_period: c.tou_period,
      rate_per_kwh: c.rate_per_kwh,
      cost_per_hour: c.cost_per_hour,
      accumulated_cost: accumulatedCost,
      outdoor_temp_f: c.outdoor_temp_f,
      outdoor_rh: w?.outdoor_rh ?? null,
      outdoor_pressure_inhg: c.barometric_pressure_inhg,
      weather_source: w?.weather_source ?? null,
      weather_station_id: w?.weather_station_id ?? null,
      weather_obs_timestamp: w?.weather_obs_timestamp ?? null,
      weather_obs_age_min: w?.weather_obs_age_min ?? null,
      weather_confidence: c.weather_confidence,
      efficiency_color: c.efficiency_color,
    }

    const { error: insErr } = await supabase.from("computed_readings").insert(row)
    if (insErr) {
      return NextResponse.json({ ok: false, error: insErr.message }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      persisted: true,
      reading_at: bundle.readingAt,
      accumulated_cost: accumulatedCost,
      month: thisMonth,
      efficiency_color: c.efficiency_color,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
