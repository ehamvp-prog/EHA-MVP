// =====================================================================
// GET /api/comfort/segments?date=YYYY-MM-DD&view=daily|weekly|monthly
// Read-only. Intraday INDOOR temperature/humidity segments for the anchor
// window, via the indoor_segments RPC (24 seg/day daily, 12 weekly, 8 monthly),
// bucketed in America/Chicago. Each point carries min/max so the chart can draw
// a range band (that band is what makes a 4–6pm 76°F spike visible instead of
// being averaged away). Also returns a flat Happy Number from the comfort
// profile and the selectable month list. Changes no data.
// =====================================================================

import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { SITE_ID } from "@/lib/compute-reading"
import { comfortFromConditions } from "@/lib/comfort/ring"
import { type ComfortProfile } from "@/lib/comfort/happy-number"
import { chicagoParts, chicagoChartWindow, chicagoMonthIndex, type ChartView } from "@/lib/chicago-time"

export const dynamic = "force-dynamic"

const DEFAULT_PROFILE: ComfortProfile = {
  preferred_temp_f: 72,
  preferred_rh: 45,
  age_group: "adults",
  activity_level: "moderate",
  household_size: 2,
  health_considerations: [],
}

type SegRow = {
  bucket_start: string
  day_local: string
  seg_index: number
  avg_temp_f: number | string | null
  min_temp_f: number | string | null
  max_temp_f: number | string | null
  avg_rh: number | string | null
  readings: number | string | null
  source: string | null
}

function parseView(v: string | null): ChartView {
  return v === "weekly" || v === "monthly" ? v : "daily"
}

const num = (v: number | string | null): number | null =>
  v == null ? null : Math.round(Number(v) * 10) / 10

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

    const [segRes, profRes, monthsRes] = await Promise.all([
      supabase.rpc("indoor_segments", {
        p_site_id: SITE_ID,
        p_from: fromISO,
        p_to: toISO,
        p_segments: segments,
      }),
      supabase.from("comfort_profile").select("*").eq("site_id", SITE_ID).maybeSingle(),
      supabase
        .from("energy_monthly")
        .select("month_local")
        .eq("site_id", SITE_ID)
        .order("month_local", { ascending: false }),
    ])
    if (segRes.error) throw segRes.error

    const profile: ComfortProfile = (profRes.data as ComfortProfile | null) ?? DEFAULT_PROFILE
    // Happy Number = pure comfort of the user's preferred conditions, computed
    // exactly like the settings screen. Flat reference line, never telemetry.
    const happy = comfortFromConditions(
      profile.preferred_temp_f,
      profile.preferred_rh,
      profile,
      chicagoMonthIndex(),
    )

    const points = ((segRes.data ?? []) as SegRow[]).map((r) => ({
      day: String(r.day_local),
      seg: Number(r.seg_index),
      avgTemp: num(r.avg_temp_f),
      minTemp: num(r.min_temp_f),
      maxTemp: num(r.max_temp_f),
      avgRh: num(r.avg_rh),
      readings: Number(r.readings ?? 0),
      source: r.source ?? null,
    }))

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
      happy,
      preferredTemp: profile.preferred_temp_f,
      points,
      availableMonths,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
