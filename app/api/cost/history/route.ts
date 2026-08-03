// =====================================================================
// GET /api/cost/history
// Read-only. Returns the trailing-7-day and today energy spend for the
// dashboard cost tiles, summed from the energy_daily ledger view (computed
// every minute by cron from raw telemetry). Reads NO accumulated_cost.
// =====================================================================

import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { SITE_ID } from "@/lib/compute-reading"

export const dynamic = "force-dynamic"

// Today's date key in America/Chicago (matches energy_daily.day_local). Real
// timezone conversion — correct across DST.
function chicagoToday(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d)
}

export async function GET() {
  try {
    const supabase = createAdminClient()

    const today = chicagoToday()
    // Trailing 7 calendar days, inclusive of today.
    const cutoffDate = new Date(`${today}T12:00:00Z`)
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - 6)
    const cutoff = cutoffDate.toISOString().slice(0, 10)

    const { data, error } = await supabase
      .from("energy_daily")
      .select("day_local, cost")
      .eq("site_id", SITE_ID)
      .gte("day_local", cutoff)
      .lte("day_local", today)
    if (error) throw error

    const rows = (data ?? []) as { day_local: string; cost: number | string }[]
    const week_to_date = rows.reduce((sum, r) => sum + Number(r.cost ?? 0), 0)
    const todaySpend = Number(rows.find((r) => r.day_local === today)?.cost ?? 0)

    return NextResponse.json({
      ok: true,
      week_to_date: Math.round(week_to_date * 100) / 100,
      today: Math.round(todaySpend * 100) / 100,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
