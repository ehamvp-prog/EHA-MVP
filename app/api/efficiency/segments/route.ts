// =====================================================================
// GET /api/efficiency/segments?date=YYYY-MM-DD&view=daily|weekly|monthly
// Read-only. Intraday EFFICIENCY segments (live EER + delivered capacity) for
// the anchor window, via the efficiency_segments RPC (24 seg/day daily, 12
// weekly, 8 monthly), bucketed in America/Chicago and filtered to steady-state
// so compressor-startup transients don't create garbage points. Each point
// carries min/max EER for a range band; rated_seer2 is the nameplate reference
// line. Also returns the selectable month list. Changes no data.
// =====================================================================

import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { SITE_ID } from "@/lib/compute-reading"
import { chicagoParts, chicagoChartWindow, type ChartView } from "@/lib/chicago-time"
import { seer2ConversionFactor } from "@/lib/engine/seer2"

export const dynamic = "force-dynamic"

type SegRow = {
  bucket_start: string
  day_local: string
  seg_index: number
  avg_eer: number | string | null
  min_eer: number | string | null
  max_eer: number | string | null
  avg_capacity_btuh: number | string | null
  avg_watts: number | string | null
  cooling_minutes: number | string | null
  rated_seer2: number | string | null
}

function parseView(v: string | null): ChartView {
  return v === "weekly" || v === "monthly" ? v : "daily"
}

const r1 = (v: number | string | null): number | null =>
  v == null ? null : Math.round(Number(v) * 10) / 10
const r0 = (v: number | string | null): number | null =>
  v == null ? null : Math.round(Number(v))

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

    const [segRes, monthsRes, profRes] = await Promise.all([
      supabase.rpc("efficiency_segments", {
        p_site_id: SITE_ID,
        p_from: fromISO,
        p_to: toISO,
        p_segments: segments,
      }),
      supabase
        .from("energy_monthly")
        .select("month_local")
        .eq("site_id", SITE_ID)
        .order("month_local", { ascending: false }),
      // Equipment-class-aware factor that converts live EER → measured SEER2,
      // so the band is directly comparable to the rated SEER2 nameplate line.
      supabase
        .from("system_profile")
        .select("equipment_class, seer2_conversion_factor")
        .eq("site_id", SITE_ID)
        .maybeSingle(),
    ])
    if (segRes.error) throw segRes.error

    const { factor } = seer2ConversionFactor(
      profRes.data?.equipment_class ?? null,
      profRes.data?.seer2_conversion_factor ?? null,
    )
    // EER → measured SEER2 (rounded to 1 decimal after conversion).
    const toSeer2 = (v: number | string | null): number | null =>
      v == null ? null : Math.round(Number(v) * factor * 10) / 10

    const rows = (segRes.data ?? []) as SegRow[]
    const points = rows.map((r) => ({
      day: String(r.day_local),
      seg: Number(r.seg_index),
      // Measured SEER2 (EER × conversion factor) so it lines up with rated SEER2.
      avgSeer2: toSeer2(r.avg_eer),
      minSeer2: toSeer2(r.min_eer),
      maxSeer2: toSeer2(r.max_eer),
      capacity: r0(r.avg_capacity_btuh),
      watts: r0(r.avg_watts),
      coolingMinutes: Number(r.cooling_minutes ?? 0),
    }))

    // Nameplate reference line (constant across the unit).
    const ratedSeer2 = rows.length ? r1(rows[0].rated_seer2) : null

    const availableMonths = ((monthsRes.data ?? []) as { month_local: string }[]).map((r) => {
      const [y, m] = String(r.month_local).split("-").map(Number)
      return { year: y, month: m }
    })
    if (availableMonths.length === 0) availableMonths.push({ year, month })

    return NextResponse.json({
      ok: true,
      view,
      year,
      month,
      day,
      segments,
      days,
      ratedSeer2,
      points,
      availableMonths,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
