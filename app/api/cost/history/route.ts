// =====================================================================
// GET /api/cost/history
// Read-only. Returns daily ENERGY spend for the last ~31 days (from the
// daily_cost_history SQL function) plus a rolled-up "this week" total.
// Used by the Home View cost-history chart. Changes no data.
// =====================================================================

import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { SITE_ID } from "@/lib/compute-reading"

export const dynamic = "force-dynamic"

const CST_OFFSET_MS = 6 * 60 * 60 * 1000

// Today's date key in Evergy's Central time, matching the SQL bucketing.
function cstToday(): string {
  const cst = new Date(Date.now() - CST_OFFSET_MS)
  return `${cst.getUTCFullYear()}-${String(cst.getUTCMonth() + 1).padStart(2, "0")}-${String(
    cst.getUTCDate(),
  ).padStart(2, "0")}`
}

export async function GET() {
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase.rpc("daily_cost_history", {
      p_site_id: SITE_ID,
      p_days: 31,
    })
    if (error) throw error

    const days: { day: string; spend: number }[] = (
      (data ?? []) as { day: string; spend: number | string }[]
    ).map((r) => ({
      day: String(r.day),
      spend: Number(r.spend ?? 0),
    }))

    // Sum the trailing 7 calendar days (energy only) for the "this week" tile.
    const cutoff = new Date(Date.now() - CST_OFFSET_MS - 6 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10)
    const weekToDate = days
      .filter((d) => d.day >= cutoff)
      .reduce((sum, d) => sum + d.spend, 0)

    const today = cstToday()
    const todaySpend = days.find((d) => d.day === today)?.spend ?? 0

    return NextResponse.json({
      ok: true,
      days,
      week_to_date: weekToDate,
      today: todaySpend,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
