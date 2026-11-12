// =====================================================================
// GET /api/heating/summary
// Read-only. Furnace numbers for the Home screen heating tiles:
//   today        cycles, burn minutes, short cycles, ignitions, avg rise,
//                gas used + cost (Chicago calendar day)
//   week / month gas cost from the cycle ledger
//   season       delivered ÷ gas input over every measured cycle since
//                July 1 — the number you hold up against the AFUE sticker
//   setup        what's still missing for the efficiency numbers
// =====================================================================

import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { SITE_ID } from "@/lib/compute-reading"
import { chicagoParts, chicagoWallClockToUtc } from "@/lib/chicago-time"
import { expectedSteadyStateBand, seasonalDeliveredEfficiencyPct } from "@/lib/engine/heating/afue"

export const dynamic = "force-dynamic"

// Fewer measured cycles than this and the season number is shown greyed.
const SEASON_MIN_CYCLES = 20

type CycleRow = {
  started_at: string
  burn_seconds: number
  ignitions: number
  short_cycle: boolean
  gas_input_btu: number | string | null
  delivered_btu: number | string | null
  avg_rise_f: number | string | null
  gas_cost_usd: number | string | null
}

const n = (v: number | string | null | undefined): number | null =>
  v == null || !Number.isFinite(Number(v)) ? null : Number(v)

export async function GET() {
  try {
    const supabase = createAdminClient()
    const now = new Date()
    const t = chicagoParts(now)

    const dayStart = chicagoWallClockToUtc(t.year, t.month, t.day, 0)
    // Week starts Sunday (matches the cost "This week" tile).
    const weekStart = chicagoWallClockToUtc(t.year, t.month, t.day - t.weekday, 0)
    const monthStart = chicagoWallClockToUtc(t.year, t.month, 1, 0)
    const seasonYear = t.month >= 7 ? t.year : t.year - 1
    const seasonStart = chicagoWallClockToUtc(seasonYear, 7, 1, 0)

    const [cyclesRes, profRes, stateRes] = await Promise.all([
      supabase
        .from("heat_cycles")
        .select("started_at, burn_seconds, ignitions, short_cycle, gas_input_btu, delivered_btu, avg_rise_f, gas_cost_usd")
        .eq("site_id", SITE_ID)
        .gte("started_at", seasonStart.toISOString())
        .order("started_at", { ascending: true })
        .limit(5000),
      supabase
        .from("system_profile")
        .select(
          "furnace_afue_rated_pct, furnace_condensing, furnace_rise_min_f, furnace_rise_max_f, gas_rate_per_therm, furnace_input_low_fire_btuh, furnace_input_high_fire_btuh, furnace_input_nameplate_btuh, furnace_signature, heat_cfm",
        )
        .eq("site_id", SITE_ID)
        .maybeSingle(),
      supabase.from("heating_decode_state").select("updated_at, last_sample_at, open_cycle").eq("site_id", SITE_ID).maybeSingle(),
    ])
    if (cyclesRes.error) throw new Error(cyclesRes.error.message)

    const cycles = (cyclesRes.data ?? []) as CycleRow[]
    const p = (profRes.data ?? {}) as Record<string, unknown>

    const since = (d: Date) => cycles.filter((c) => Date.parse(c.started_at) >= d.getTime())
    const sum = (rows: CycleRow[], f: (c: CycleRow) => number | null) =>
      rows.reduce((a, c) => a + (f(c) ?? 0), 0)
    const anyCost = (rows: CycleRow[]) => rows.some((c) => n(c.gas_cost_usd) != null)

    const today = since(dayStart)
    const burns = today.filter((c) => c.burn_seconds > 0)
    const rises = today.map((c) => n(c.avg_rise_f)).filter((v): v is number => v != null)

    // Season: only cycles where both sides were measured.
    const measured = cycles.filter((c) => n(c.gas_input_btu) != null && n(c.delivered_btu) != null)
    const seasonPct = seasonalDeliveredEfficiencyPct(
      sum(measured, (c) => n(c.delivered_btu)),
      sum(measured, (c) => n(c.gas_input_btu)),
    )

    const seasonBurns = cycles.filter((c) => c.burn_seconds > 0)
    const seasonRises = seasonBurns.map((c) => n(c.avg_rise_f)).filter((v): v is number => v != null)

    const afue = n(p.furnace_afue_rated_pct as number | null)
    const condensing = (p.furnace_condensing as boolean | null) ?? null
    const band = expectedSteadyStateBand(afue, condensing)

    const sig = p.furnace_signature as { commissioned?: boolean } | null
    const hasInput =
      n(p.furnace_input_low_fire_btuh as number | null) != null ||
      n(p.furnace_input_high_fire_btuh as number | null) != null ||
      n(p.furnace_input_nameplate_btuh as number | null) != null

    const round = (v: number | null, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d)

    return NextResponse.json({
      ok: true,
      today: {
        cycles: burns.length,
        burn_minutes: round(sum(today, (c) => c.burn_seconds) / 60, 0),
        avg_burn_minutes: burns.length ? round(sum(burns, (c) => c.burn_seconds) / 60 / burns.length, 1) : null,
        short_cycles: burns.filter((c) => c.short_cycle).length,
        ignitions: sum(today, (c) => c.ignitions),
        failed_lights: today.filter((c) => c.burn_seconds === 0 && c.ignitions > 0).length,
        avg_rise_f: rises.length ? round(rises.reduce((a, b) => a + b, 0) / rises.length, 0) : null,
        gas_therms: round(sum(today, (c) => n(c.gas_input_btu)) / 100000, 2),
        gas_cost: anyCost(today) ? round(sum(today, (c) => n(c.gas_cost_usd)), 2) : null,
      },
      week: { gas_cost: anyCost(since(weekStart)) ? round(sum(since(weekStart), (c) => n(c.gas_cost_usd)), 2) : null },
      month: { gas_cost: anyCost(since(monthStart)) ? round(sum(since(monthStart), (c) => n(c.gas_cost_usd)), 2) : null },
      season: {
        since: `${seasonYear}-07-01`,
        cycles: cycles.filter((c) => c.burn_seconds > 0).length,
        measured_cycles: measured.length,
        delivered_pct: round(seasonPct, 1),
        enough: measured.length >= SEASON_MIN_CYCLES,
        min_cycles: SEASON_MIN_CYCLES,
        // The "why" beside the season number.
        short_cycle_pct: seasonBurns.length ? round((seasonBurns.filter((c) => c.short_cycle).length / seasonBurns.length) * 100, 0) : null,
        avg_rise_f: seasonRises.length ? round(seasonRises.reduce((a, b) => a + b, 0) / seasonRises.length, 0) : null,
        avg_burn_minutes: seasonBurns.length ? round(sum(seasonBurns, (c) => c.burn_seconds) / 60 / seasonBurns.length, 1) : null,
      },
      rated: {
        afue_pct: afue,
        expected_band: band,
        rise_min_f: n(p.furnace_rise_min_f as number | null),
        rise_max_f: n(p.furnace_rise_max_f as number | null),
        gas_rate_per_therm: n(p.gas_rate_per_therm as number | null),
      },
      setup: {
        gas_input: hasInput,
        afue: afue != null,
        rise_range: n(p.furnace_rise_min_f as number | null) != null && n(p.furnace_rise_max_f as number | null) != null,
        gas_rate: n(p.gas_rate_per_therm as number | null) != null,
        signature_commissioned: sig?.commissioned === true,
      },
      decoder: {
        last_run: (stateRes.data?.updated_at as string | null) ?? null,
        last_sample_at: (stateRes.data?.last_sample_at as string | null) ?? null,
        cycle_in_progress: stateRes.data?.open_cycle != null,
      },
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
