// =====================================================================
// GET /api/weather-load?mode=heating|cooling
// Read-only. "How hard did the system work for how cold/hot it was."
//
// Every day: run minutes (burner-on for heat, compressor-on for cool)
// against the temperature difference between inside and outside
// (heat: indoor − outdoor, cool: outdoor − indoor). Over weeks those dots
// fall on a near-straight line — the house's fingerprint. From the line:
//   minutes per degree   how fast this house gains/loses heat
//   no-run point         outdoor temp where the system stops needing to run
//   nonstop point        outdoor temp where it runs the whole hour, read
//                        straight from hourly run time (not stretched off the line)
//   expected vs actual   how yesterday / the last 7 days compare to the line
// Only days with a real load count toward the line: for cooling, warmer
// outside than in; for heating, colder outside than in. Other days (e.g. the
// AC run on a cool day to dry the air) are shown but not counted.
// Data comes from weather_load_days (refreshed every 30 min by pg_cron) and
// weather_load_hourly() for the hour-by-hour nonstop point.
// =====================================================================

import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { SITE_ID } from "@/lib/compute-reading"
import { chicagoTodayISO } from "@/lib/chicago-time"

export const dynamic = "force-dynamic"

// Days need most of their hours covered to count.
const MIN_HOURS = 20
// Below this many running days the line is "still learning".
const MIN_DAYS = 7
const RELIABLE_DAYS = 14
// A line that explains less than this much of the day-to-day swing isn't a
// fingerprint yet (mixed modes, thermostat changes, too few cold days).
const MIN_R2 = 0.4
// Hourly nonstop point: a 2°F bucket needs this many hours to count, the
// system has to have run 55+ minutes in at least FULL_PCT% of them, and every
// hotter (cooling) / colder (heating) bucket has to stay at HOLD_PCT% or more.
const HOUR_MIN = 8
const FULL_PCT = 90
const HOLD_PCT = 75
// Don't report a point more than this far past the outdoor temps actually seen.
const STRETCH_F = 5

type HourBin = { out_f: number; hours: number; avg_on_min: number | string; pct_full: number | string }

function hourlyNonstop(bins: HourBin[], mode: "heating" | "cooling"): number | null {
  const ok = bins
    .filter((b) => b.hours >= HOUR_MIN)
    .map((b) => ({ t: Number(b.out_f), full: Number(b.pct_full) }))
    // Walk from mild toward extreme: cooling = hotter, heating = colder.
    .sort((a, b) => (mode === "cooling" ? a.t - b.t : b.t - a.t))
  for (let i = 0; i < ok.length; i++) {
    if (ok[i].full < FULL_PCT) continue
    if (ok.slice(i + 1).every((b) => b.full >= HOLD_PCT)) {
      // Bucket is [t, t+2): report its middle.
      return ok[i].t + 1
    }
  }
  return null
}

type Row = {
  day_local: string
  run_minutes: number | string
  avg_indoor_f: number | string | null
  avg_outdoor_f: number | string | null
  delta_t_f: number | string | null
  delivered_btu: number | string | null
  indoor_hours: number | null
  outdoor_hours: number | null
}

const num = (v: unknown): number | null => (v == null || !Number.isFinite(Number(v)) ? null : Number(v))
const r1 = (v: number | null) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10)

function fitLine(pts: { x: number; y: number }[]) {
  const n = pts.length
  if (n < 3) return null
  const mx = pts.reduce((a, p) => a + p.x, 0) / n
  const my = pts.reduce((a, p) => a + p.y, 0) / n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (const p of pts) {
    sxy += (p.x - mx) * (p.y - my)
    sxx += (p.x - mx) ** 2
    syy += (p.y - my) ** 2
  }
  if (sxx === 0) return null
  const slope = sxy / sxx
  const intercept = my - slope * mx
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy)
  return { slope, intercept, r2, n }
}

export async function GET(request: Request) {
  try {
    const mode = new URL(request.url).searchParams.get("mode") === "cooling" ? "cooling" : "heating"
    const supabase = createAdminClient()
    const since = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10)
    const { data, error } = await supabase
      .from("weather_load_days")
      .select("day_local, run_minutes, avg_indoor_f, avg_outdoor_f, delta_t_f, delivered_btu, indoor_hours, outdoor_hours")
      .eq("site_id", SITE_ID)
      .eq("mode", mode)
      .gte("day_local", since)
      .order("day_local", { ascending: true })
    if (error) throw new Error(error.message)

    const today = chicagoTodayISO()
    const rows = (data ?? []) as Row[]
    const points = rows.map((r) => ({
      day: String(r.day_local),
      deltaT: num(r.delta_t_f),
      run: num(r.run_minutes) ?? 0,
      indoor: num(r.avg_indoor_f),
      outdoor: num(r.avg_outdoor_f),
      heatPerMin:
        mode === "heating" && num(r.delivered_btu) != null && (num(r.run_minutes) ?? 0) > 0
          ? Math.round(num(r.delivered_btu)! / num(r.run_minutes)!)
          : null,
      complete: r.day_local !== today && (r.indoor_hours ?? 0) >= MIN_HOURS && (r.outdoor_hours ?? 0) >= MIN_HOURS,
      counted: false,
    }))
    // A day counts when it's finished, well covered, the system ran, and there
    // was a real load (ΔT is already signed: outside hotter for cooling,
    // colder for heating).
    for (const p of points) p.counted = p.complete && p.run > 0 && p.deltaT != null && p.deltaT > 0

    const fitPts = points.filter((p) => p.counted).map((p) => ({ x: p.deltaT!, y: p.run }))
    const rawFit = fitLine(fitPts)
    const runDays = fitPts.length
    // Only trust a line that slopes the right way and actually fits the days.
    const fit = rawFit && rawFit.slope > 0 && rawFit.r2 >= MIN_R2 && runDays >= MIN_DAYS ? rawFit : null
    const status = !fit ? "learning" : runDays < RELIABLE_DAYS ? "early" : "reliable"

    const expected = (dt: number | null) =>
      fit && dt != null ? Math.max(0, Math.min(1440, fit.slope * dt + fit.intercept)) : null

    // Typical indoor temp lately, for turning temperature differences into outdoor temps.
    // Taken from counted days so a different season's thermostat setting
    // doesn't shift the line.
    const countedIndoor = points.filter((p) => p.counted && p.indoor != null)
    const recentIndoor = (countedIndoor.length ? countedIndoor : points.filter((p) => p.indoor != null)).slice(-30)
    const indoorAvg = recentIndoor.length ? recentIndoor.reduce((a, p) => a + p.indoor!, 0) / recentIndoor.length : null
    // Heat: outdoor = indoor − ΔT. Cool: outdoor = indoor + ΔT.
    const toOutdoor = (dt: number) => (indoorAvg == null ? null : mode === "heating" ? indoorAvg - dt : indoorAvg + dt)
    const usableFit = fit != null
    const noRunDelta = usableFit ? -fit!.intercept / fit!.slope : null
    const nonstopDelta = usableFit ? (1440 - fit!.intercept) / fit!.slope : null

    // Outdoor temps actually seen on counted days: answers are only given
    // inside that range (plus a few degrees), never stretched off the line.
    const countedOut = points.filter((p) => p.counted && p.outdoor != null).map((p) => p.outdoor!)
    const outMin = countedOut.length ? Math.min(...countedOut) : null
    const outMax = countedOut.length ? Math.max(...countedOut) : null
    const inRange = (v: number | null) =>
      v != null && outMin != null && outMax != null && v >= outMin - STRETCH_F && v <= outMax + STRETCH_F ? r1(v) : null
    const noRunOutdoor = noRunDelta != null ? inRange(toOutdoor(noRunDelta)) : null
    const lineNonstop = nonstopDelta != null ? inRange(toOutdoor(nonstopDelta)) : null

    // Nonstop point, hour by hour: the outdoor temp at which the system runs
    // the whole hour. This is what the household actually feels.
    const { data: bins } = await supabase.rpc("weather_load_hourly", { p_mode: mode, p_site: SITE_ID, p_days: 150 })
    const hourNonstop = hourlyNonstop((bins ?? []) as HourBin[], mode)

    // The line drawn on the chart, in outdoor temps.
    // Cool: run = s·(out − in) + b. Heat: run = s·(in − out) + b.
    const lineOutdoor =
      usableFit && indoorAvg != null
        ? mode === "cooling"
          ? { slope: fit!.slope, intercept: fit!.intercept - fit!.slope * indoorAvg }
          : { slope: -fit!.slope, intercept: fit!.intercept + fit!.slope * indoorAvg }
        : null

    // Latest and the last 7 counted days: actual vs what the line expects.
    // Only days with a real load — the line says nothing about the others.
    const finished = points.filter((p) => p.counted)
    const yesterday = finished.length ? finished[finished.length - 1] : null
    const last7 = finished.slice(-7)
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)
    const last7Actual = sum(last7.map((p) => p.run))
    const last7Expected = usableFit ? sum(last7.map((p) => expected(p.deltaT) ?? 0)) : null

    const pct = (actual: number, exp: number | null) =>
      exp == null || exp < 10 ? null : Math.round(((actual - exp) / exp) * 100)

    // Heat per burner minute: recent vs the season average (heating only).
    const hpm = points.filter((p) => p.heatPerMin != null)
    const hpmAvg = hpm.length ? Math.round(sum(hpm.map((p) => p.heatPerMin!)) / hpm.length) : null
    const hpmRecent = hpm.length ? hpm[hpm.length - 1].heatPerMin : null

    return NextResponse.json({
      ok: true,
      mode,
      status,
      run_days: runDays,
      min_days: MIN_DAYS,
      reliable_days: RELIABLE_DAYS,
      points,
      fit: fit
        ? { slope: r1(fit.slope), intercept: r1(fit.intercept), r2: Math.round(fit.r2 * 100) / 100, n: fit.n }
        : null,
      line_outdoor: lineOutdoor
        ? { slope: Math.round(lineOutdoor.slope * 100) / 100, intercept: Math.round(lineOutdoor.intercept) }
        : null,
      indoor_avg_f: r1(indoorAvg),
      counted_outdoor_range: outMin != null ? [r1(outMin), r1(outMax)] : null,
      no_run_outdoor_f: noRunOutdoor,
      nonstop_outdoor_f: hourNonstop ?? lineNonstop,
      nonstop_source: hourNonstop != null ? "hourly" : lineNonstop != null ? "line" : null,
      not_counted_days: points.filter((p) => p.complete && p.run > 0 && !p.counted).length,
      // Why it's still learning, in plain words.
      learning_reason: fit
        ? null
        : runDays < MIN_DAYS
          ? "few_days"
          : "inconsistent",
      fit_r2_raw: rawFit ? Math.round(rawFit.r2 * 100) / 100 : null,
      yesterday: yesterday
        ? {
            day: yesterday.day,
            actual: Math.round(yesterday.run),
            expected: expected(yesterday.deltaT) != null ? Math.round(expected(yesterday.deltaT)!) : null,
            pct: pct(yesterday.run, expected(yesterday.deltaT)),
            outdoor: r1(yesterday.outdoor),
            indoor: r1(yesterday.indoor),
          }
        : null,
      last7: {
        days: last7.length,
        actual: Math.round(last7Actual),
        expected: last7Expected != null ? Math.round(last7Expected) : null,
        pct: pct(last7Actual, last7Expected),
      },
      heat_per_min: mode === "heating" ? { recent_btu: hpmRecent, avg_btu: hpmAvg } : null,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
