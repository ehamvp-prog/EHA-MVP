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

// A period during which one comfort anchor (learned target) was in effect.
type AnchorRow = {
  effective_from: string
  effective_to: string
  anchor_temp_f: number | string | null
  anchor_rh: number | string | null
  source: string | null
}

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

    const [segRes, profRes, monthsRes, anchorRes] = await Promise.all([
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
      // Anchor timeline for the SAME window → drives the Happy Number step line.
      supabase.rpc("happy_anchor_history", {
        p_site_id: SITE_ID,
        p_from: fromISO,
        p_to: toISO,
      }),
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

    // Anchor periods, oldest→newest. For any bucket we pick the anchor whose
    // [from, to) span contains the bucket start — that's the target the system
    // was learning toward at that moment.
    const anchors = ((anchorRes.data ?? []) as AnchorRow[])
      .map((a) => ({
        from: new Date(a.effective_from).getTime(),
        to: new Date(a.effective_to).getTime(),
        tempF: Number(a.anchor_temp_f),
        rh: Number(a.anchor_rh),
      }))
      .filter((a) => Number.isFinite(a.tempF) && Number.isFinite(a.rh))
    const anchorAt = (ts: number) =>
      anchors.find((a) => ts >= a.from && ts < a.to) ?? anchors[anchors.length - 1] ?? null

    const points = ((segRes.data ?? []) as SegRow[]).map((r) => {
      const avgTemp = num(r.avg_temp_f)
      const avgRh = num(r.avg_rh)
      const bucketStart = String(r.bucket_start)
      const monthIdx = chicagoMonthIndex(new Date(bucketStart))

      // Comfort Score for the bucket — v0's tested comfort model on the bucket's
      // own avg temp + humidity (NOT computed in SQL). 0–100, right axis.
      const comfortScore =
        avgTemp != null && avgRh != null
          ? comfortFromConditions(avgTemp, avgRh, profile, monthIdx)
          : null

      // Happy Number in effect during the bucket — the anchor's comfort score.
      // Steps whenever training moved the anchor. 0–100, right axis.
      const anchor = anchorAt(new Date(bucketStart).getTime())
      const happyStep = anchor ? comfortFromConditions(anchor.tempF, anchor.rh, profile, monthIdx) : null

      return {
        day: String(r.day_local),
        seg: Number(r.seg_index),
        bucketStart,
        avgTemp,
        minTemp: num(r.min_temp_f),
        maxTemp: num(r.max_temp_f),
        avgRh,
        comfortScore,
        happyStep,
        readings: Number(r.readings ?? 0),
        source: r.source ?? null,
      }
    })

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
