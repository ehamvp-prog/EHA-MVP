// =====================================================================
// GET /api/cost/period?date=YYYY-MM-DD
// Read-only. Returns ENERGY spend for a single anchor day, resolved for all
// three chart granularities at once:
//   - hours:  hourly spend for the anchor day (0..23, zero-filled)
//   - week:   daily spend for the week-of-month containing the anchor,
//             zero-filled across every day in that calendar-week chunk
//   - month:  weekly spend for the anchor's month (weeks 1..N, zero-filled)
// plus the set of selectable months. Buckets with no data or in the future
// are returned with spend 0 so they stay visible on the chart.
// Changes no data.
// =====================================================================

import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { SITE_ID } from "@/lib/compute-reading"

export const dynamic = "force-dynamic"

const CST_OFFSET_MS = 6 * 60 * 60 * 1000

function iso(y: number, m: number, d: number) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
}

export async function GET(request: Request) {
  try {
    const supabase = createAdminClient()
    const { searchParams } = new URL(request.url)

    // Anchor day in Central time; default to today (CST).
    const nowCst = new Date(Date.now() - CST_OFFSET_MS)
    const raw = searchParams.get("date")
    const parsed = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw.split("-").map(Number) : null
    const year = parsed ? parsed[0] : nowCst.getUTCFullYear()
    const month = parsed ? parsed[1] : nowCst.getUTCMonth() + 1
    const day = parsed ? parsed[2] : nowCst.getUTCDate()

    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
    const safeDay = Math.min(Math.max(day, 1), daysInMonth)
    const anchor = iso(year, month, safeDay)

    // Week-of-month chunk (1..5) containing the anchor day.
    const weekOfMonth = Math.min(Math.ceil(safeDay / 7), 5)
    const weekStartDay = (weekOfMonth - 1) * 7 + 1
    const weekEndDay = Math.min(weekOfMonth * 7, daysInMonth)
    const weekStart = iso(year, month, weekStartDay)
    const weekEnd = iso(year, month, weekEndDay)

    const [hourly, weekRange, monthWeeks, earliest] = await Promise.all([
      supabase.rpc("hourly_cost_for_day", { p_site_id: SITE_ID, p_day: anchor }),
      supabase.rpc("daily_cost_for_range", { p_site_id: SITE_ID, p_start: weekStart, p_end: weekEnd }),
      supabase.rpc("weekly_cost_for_month", { p_site_id: SITE_ID, p_year: year, p_month: month }),
      supabase
        .from("computed_readings")
        .select("reading_at")
        .eq("site_id", SITE_ID)
        .order("reading_at", { ascending: true })
        .limit(1),
    ])
    if (hourly.error) throw hourly.error
    if (weekRange.error) throw weekRange.error
    if (monthWeeks.error) throw monthWeeks.error

    // ---- Hours (0..23, zero-filled) ----
    const hourMap = new Map<number, { spend: number; tou: string }>()
    for (const r of (hourly.data ?? []) as { hour: number; avg_cost: number | string; tou_period: string | null }[]) {
      hourMap.set(Number(r.hour), { spend: Number(r.avg_cost ?? 0), tou: r.tou_period ?? "off-peak" })
    }
    const hours = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      spend: hourMap.get(h)?.spend ?? 0,
      tou: hourMap.get(h)?.tou ?? "off-peak",
    }))

    // ---- Week (each day in the chunk, zero-filled) ----
    const dayMap = new Map<string, number>()
    for (const r of (weekRange.data ?? []) as { day: string; spend: number | string }[]) {
      dayMap.set(String(r.day), Number(r.spend ?? 0))
    }
    const week: { day: string; spend: number }[] = []
    for (let d = weekStartDay; d <= weekEndDay; d++) {
      const key = iso(year, month, d)
      week.push({ day: key, spend: dayMap.get(key) ?? 0 })
    }

    // ---- Month (weeks 1..N, zero-filled) ----
    const weekCount = Math.min(Math.ceil(daysInMonth / 7), 5)
    const monthMap = new Map<number, number>()
    for (const r of (monthWeeks.data ?? []) as { week: number; cost: number | string }[]) {
      monthMap.set(Number(r.week), Number(r.cost ?? 0))
    }
    const month_weeks = Array.from({ length: weekCount }, (_, i) => {
      const wk = i + 1
      const startD = (wk - 1) * 7 + 1
      const endD = Math.min(wk * 7, daysInMonth)
      return {
        week: wk,
        startDay: iso(year, month, startD),
        endDay: iso(year, month, endD),
        spend: monthMap.get(wk) ?? 0,
      }
    })

    const monthTotal = month_weeks.reduce((s, w) => s + w.spend, 0)

    const earliestIso = (earliest.data?.[0]?.reading_at as string | undefined) ?? null
    const availableMonths = buildAvailableMonths(earliestIso, nowCst)

    return NextResponse.json({
      ok: true,
      anchor,
      year,
      month,
      day: safeDay,
      weekOfMonth,
      hours,
      week,
      weeks: month_weeks,
      monthTotal: Math.round(monthTotal * 100) / 100,
      availableMonths,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

// Inclusive list of { year, month } from the earliest data month to the
// current Central-time month, newest first.
function buildAvailableMonths(
  earliestIso: string | null,
  nowCst: Date,
): { year: number; month: number }[] {
  const endY = nowCst.getUTCFullYear()
  const endM = nowCst.getUTCMonth() + 1

  let startY = endY
  let startM = endM
  if (earliestIso) {
    const e = new Date(new Date(earliestIso).getTime() - CST_OFFSET_MS)
    startY = e.getUTCFullYear()
    startM = e.getUTCMonth() + 1
  }

  const out: { year: number; month: number }[] = []
  let y = startY
  let m = startM
  while (y < endY || (y === endY && m <= endM)) {
    out.push({ year: y, month: m })
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return out.reverse()
}
