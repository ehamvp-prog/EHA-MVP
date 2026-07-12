// =====================================================================
// GET /api/cost/monthly?year=YYYY&month=M
// Read-only. Returns ENERGY spend broken into weeks (1..5) of a selected
// calendar month, plus the set of months that actually have data (so the
// picker only offers real options). Used by the Home View spend chart's
// month/year selector. Changes no data.
// =====================================================================

import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { SITE_ID } from "@/lib/compute-reading"

export const dynamic = "force-dynamic"

const CST_OFFSET_MS = 6 * 60 * 60 * 1000

type WeekRow = {
  week: number
  start_day: string
  end_day: string
  cost: number | string
  readings: number | string
}

export async function GET(request: Request) {
  try {
    const supabase = createAdminClient()
    const { searchParams } = new URL(request.url)

    // Default to the current month in Central time.
    const nowCst = new Date(Date.now() - CST_OFFSET_MS)
    const year = Number(searchParams.get("year")) || nowCst.getUTCFullYear()
    const month = Number(searchParams.get("month")) || nowCst.getUTCMonth() + 1

    const [weekly, range] = await Promise.all([
      supabase.rpc("weekly_cost_for_month", {
        p_site_id: SITE_ID,
        p_year: year,
        p_month: month,
      }),
      // Distinct (year, month) pairs that have readings, newest first.
      supabase
        .from("computed_readings")
        .select("reading_at")
        .eq("site_id", SITE_ID)
        .order("reading_at", { ascending: true })
        .limit(1),
    ])
    if (weekly.error) throw weekly.error

    const weeks = ((weekly.data ?? []) as WeekRow[]).map((r) => ({
      week: Number(r.week),
      startDay: String(r.start_day),
      endDay: String(r.end_day),
      spend: Number(r.cost ?? 0),
    }))

    // Build the list of selectable months from the earliest reading through
    // the current month, so the picker never offers empty future months.
    const earliestIso = (range.data?.[0]?.reading_at as string | undefined) ?? null
    const availableMonths = buildAvailableMonths(earliestIso, nowCst)

    const total = weeks.reduce((sum, w) => sum + w.spend, 0)

    return NextResponse.json({
      ok: true,
      year,
      month,
      weeks,
      total: Math.round(total * 100) / 100,
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
