// =====================================================================
// GET /api/heating/segments?date=YYYY-MM-DD&view=daily|weekly|monthly
// Read-only. Furnace history for the heating efficiency chart, on the same
// Chicago segment scheme as the cooling chart (24/day daily, 12 weekly,
// 8 monthly). Built from the heat_cycles ledger: each cycle lands in the
// segment it started in. Per segment: avg/min/max live efficiency %, avg /
// min / max temperature rise, burn minutes and cycle count.
// =====================================================================

import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { SITE_ID } from "@/lib/compute-reading"
import { chicagoParts, chicagoChartWindow, chicagoTodayISO, type ChartView } from "@/lib/chicago-time"
import { expectedSteadyStateBand } from "@/lib/engine/heating/afue"

export const dynamic = "force-dynamic"

function parseView(v: string | null): ChartView {
  return v === "weekly" || v === "monthly" ? v : "daily"
}

const num = (v: unknown): number | null => (v == null || !Number.isFinite(Number(v)) ? null : Number(v))
const r1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10)

type Agg = { eff: number[]; rise: number[]; burnS: number; cycles: number }

export async function GET(request: Request) {
  try {
    const supabase = createAdminClient()
    const { searchParams } = new URL(request.url)
    const view = parseView(searchParams.get("view"))

    const today = chicagoParts()
    const raw = searchParams.get("date")
    const p = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw.split("-").map(Number) : null
    const year = p ? p[0] : today.year
    const month = p ? p[1] : today.month
    const day = p ? p[2] : today.day

    const { fromISO, toISO, segments, days } = chicagoChartWindow(view, year, month, day)

    const [cycRes, allRes, profRes] = await Promise.all([
      supabase
        .from("heat_cycles")
        .select("started_at, burn_seconds, live_eff_pct, avg_rise_f")
        .eq("site_id", SITE_ID)
        .gte("started_at", fromISO)
        .lt("started_at", toISO)
        .order("started_at", { ascending: true })
        .limit(5000),
      // Months that have any furnace cycles, for the month picker.
      supabase.from("heat_cycles").select("started_at").eq("site_id", SITE_ID).order("started_at", { ascending: false }).limit(5000),
      supabase
        .from("system_profile")
        .select("furnace_afue_rated_pct, furnace_condensing, furnace_rise_min_f, furnace_rise_max_f")
        .eq("site_id", SITE_ID)
        .maybeSingle(),
    ])
    if (cycRes.error) throw new Error(cycRes.error.message)

    const segHours = 24 / segments
    const buckets = new Map<string, Agg>()
    for (const c of cycRes.data ?? []) {
      if (!(Number(c.burn_seconds) > 0)) continue
      const at = new Date(c.started_at as string)
      const local = chicagoParts(at)
      const key = `${chicagoTodayISO(at)}|${Math.floor(local.hour / segHours)}`
      const b = buckets.get(key) ?? { eff: [], rise: [], burnS: 0, cycles: 0 }
      const eff = num(c.live_eff_pct)
      const rise = num(c.avg_rise_f)
      if (eff != null) b.eff.push(eff)
      if (rise != null) b.rise.push(rise)
      b.burnS += Number(c.burn_seconds)
      b.cycles++
      buckets.set(key, b)
    }

    const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)
    const points = []
    for (const d of days) {
      for (let s = 0; s < segments; s++) {
        const b = buckets.get(`${d}|${s}`)
        points.push({
          day: d,
          seg: s,
          avgEff: r1(b ? avg(b.eff) : null),
          minEff: r1(b && b.eff.length ? Math.min(...b.eff) : null),
          maxEff: r1(b && b.eff.length ? Math.max(...b.eff) : null),
          avgRise: r1(b ? avg(b.rise) : null),
          minRise: r1(b && b.rise.length ? Math.min(...b.rise) : null),
          maxRise: r1(b && b.rise.length ? Math.max(...b.rise) : null),
          burnMinutes: b ? Math.round(b.burnS / 60) : 0,
          cycles: b?.cycles ?? 0,
        })
      }
    }

    const monthSet = new Set<string>()
    for (const r of allRes.data ?? []) {
      const lp = chicagoParts(new Date(r.started_at as string))
      monthSet.add(`${lp.year}-${lp.month}`)
    }
    const availableMonths = Array.from(monthSet).map((k) => {
      const [y, m] = k.split("-").map(Number)
      return { year: y, month: m }
    })
    if (!availableMonths.some((a) => a.year === year && a.month === month)) availableMonths.push({ year, month })
    availableMonths.sort((a, b) => b.year - a.year || b.month - a.month)

    const prof = (profRes.data ?? {}) as Record<string, unknown>
    const afue = num(prof.furnace_afue_rated_pct)
    return NextResponse.json({
      ok: true,
      view,
      year,
      month,
      day,
      segments,
      days,
      afuePct: afue,
      expectedBand: expectedSteadyStateBand(afue, (prof.furnace_condensing as boolean | null) ?? null),
      riseMinF: num(prof.furnace_rise_min_f),
      riseMaxF: num(prof.furnace_rise_max_f),
      points,
      availableMonths,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
