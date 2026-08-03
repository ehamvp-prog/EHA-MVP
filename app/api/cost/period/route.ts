// =====================================================================
// GET /api/cost/period?date=YYYY-MM-DD
// Read-only. Returns ENERGY spend for a single anchor day, resolved for all
// three chart granularities at once, sourced from the energy ledger views
// (energy_minutes / energy_daily / energy_monthly), which are computed every
// minute by cron from raw telemetry and bucketed in America/Chicago:
//   - hours:  hourly spend for the anchor day (0..23, zero-filled)
//   - week:   daily spend for the week-of-month containing the anchor,
//             zero-filled across every day in that calendar-week chunk
//   - weeks:  weekly spend for the anchor's month (weeks 1..N, zero-filled)
// plus the set of selectable months. Buckets with no data or in the future
// are returned with spend 0 so they stay visible on the chart. Reads NO
// accumulated_cost. Changes no data.
// =====================================================================

import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { SITE_ID } from "@/lib/compute-reading"

export const dynamic = "force-dynamic"

function iso(y: number, m: number, d: number) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
}

// Today's date parts in America/Chicago (real tz conversion, DST-correct).
function chicagoTodayParts(d = new Date()): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d)
  return {
    year: Number(parts.find((p) => p.type === "year")!.value),
    month: Number(parts.find((p) => p.type === "month")!.value),
    day: Number(parts.find((p) => p.type === "day")!.value),
  }
}

export async function GET(request: Request) {
  try {
    const supabase = createAdminClient()
    const { searchParams } = new URL(request.url)

    // Anchor day in Central time; default to today (Chicago).
    const todayParts = chicagoTodayParts()
    const raw = searchParams.get("date")
    const parsed = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw.split("-").map(Number) : null
    const year = parsed ? parsed[0] : todayParts.year
    const month = parsed ? parsed[1] : todayParts.month
    const day = parsed ? parsed[2] : todayParts.day

    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
    const safeDay = Math.min(Math.max(day, 1), daysInMonth)
    const anchor = iso(year, month, safeDay)

    // Week-of-month chunk (1..5) containing the anchor day.
    const weekOfMonth = Math.min(Math.ceil(safeDay / 7), 5)
    const weekStartDay = (weekOfMonth - 1) * 7 + 1
    const weekEndDay = Math.min(weekOfMonth * 7, daysInMonth)

    const monthStart = iso(year, month, 1)
    const monthEnd = iso(year, month, daysInMonth)

    const [hourlyRes, monthDaysRes, monthsRes] = await Promise.all([
      // Hourly spend aggregated in Postgres over the dense energy_minutes ledger.
      // Returns <=24 rows, so PostgREST's 1,000-row response cap can never drop
      // daytime hours the way fetching raw minute rows + summing in JS did.
      supabase.rpc("hourly_energy_for_day", { p_site_id: SITE_ID, p_day: anchor }),
      supabase
        .from("energy_daily")
        .select("day_local, cost")
        .eq("site_id", SITE_ID)
        .gte("day_local", monthStart)
        .lte("day_local", monthEnd),
      supabase
        .from("energy_monthly")
        .select("month_local")
        .eq("site_id", SITE_ID)
        .order("month_local", { ascending: false }),
    ])
    if (hourlyRes.error) throw hourlyRes.error
    if (monthDaysRes.error) throw monthDaysRes.error
    if (monthsRes.error) throw monthsRes.error

    // ---- Hours (0..23, zero-filled) from the hourly RPC ----
    const hourSpend = new Array(24).fill(0)
    const hourTou = new Array<string | null>(24).fill(null)
    for (const r of (hourlyRes.data ?? []) as { hour: number; cost: number | string; tou_period: string | null }[]) {
      const h = Number(r.hour)
      if (h < 0 || h > 23) continue
      hourSpend[h] = Number(r.cost ?? 0)
      hourTou[h] = r.tou_period ?? null
    }
    const hours = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      spend: Math.round(hourSpend[h] * 10000) / 10000,
      tou: hourTou[h] ?? "off_peak",
    }))

    // ---- Daily spend map for the anchor month (energy only) ----
    const dayMap = new Map<string, number>()
    for (const r of (monthDaysRes.data ?? []) as { day_local: string; cost: number | string }[]) {
      dayMap.set(String(r.day_local), Number(r.cost ?? 0))
    }

    // ---- Week (each day in the chunk, zero-filled) ----
    const week: { day: string; spend: number }[] = []
    for (let d = weekStartDay; d <= weekEndDay; d++) {
      const key = iso(year, month, d)
      week.push({ day: key, spend: Math.round((dayMap.get(key) ?? 0) * 100) / 100 })
    }

    // ---- Month (weeks 1..N, zero-filled) ----
    const weekCount = Math.min(Math.ceil(daysInMonth / 7), 5)
    const weekTotals = new Array(weekCount + 1).fill(0)
    for (let d = 1; d <= daysInMonth; d++) {
      const wk = Math.min(Math.ceil(d / 7), 5)
      weekTotals[wk] += dayMap.get(iso(year, month, d)) ?? 0
    }
    const weeks = Array.from({ length: weekCount }, (_, i) => {
      const wk = i + 1
      const startD = (wk - 1) * 7 + 1
      const endD = Math.min(wk * 7, daysInMonth)
      return {
        week: wk,
        startDay: iso(year, month, startD),
        endDay: iso(year, month, endD),
        spend: Math.round(weekTotals[wk] * 100) / 100,
      }
    })
    const monthTotal = Math.round(weeks.reduce((s, w) => s + w.spend, 0) * 100) / 100

    // ---- Selectable months from the ledger, newest first ----
    const availableMonths = ((monthsRes.data ?? []) as { month_local: string }[]).map((r) => {
      const [y, m] = String(r.month_local).split("-").map(Number)
      return { year: y, month: m }
    })
    if (availableMonths.length === 0) availableMonths.push({ year, month })

    return NextResponse.json({
      ok: true,
      anchor,
      year,
      month,
      day: safeDay,
      weekOfMonth,
      hours,
      week,
      weeks,
      monthTotal,
      availableMonths,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
