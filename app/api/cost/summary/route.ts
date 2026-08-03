// =====================================================================
// GET /api/cost/summary
// Month-to-date electricity cost for the current Central-time month, read
// from the energy_monthly ledger view (computed every minute by cron from
// raw telemetry). total_with_base_charge already folds in the fixed Evergy
// customer charge; energy_cost is energy only. Reads NO accumulated_cost.
// =====================================================================

import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { SITE_ID } from "@/lib/compute-reading"

export const dynamic = "force-dynamic"

const MONTHLY_CUSTOMER_CHARGE = 14.25

// First-of-month key in America/Chicago (matches energy_monthly.month_local).
// Uses a real timezone conversion so it's correct across DST, unlike the old
// fixed -6h offset hack.
function chicagoMonthStart(d = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d)
  const y = parts.find((p) => p.type === "year")!.value
  const m = parts.find((p) => p.type === "month")!.value
  return `${y}-${m}-01`
}

export async function GET() {
  try {
    const supabase = createAdminClient()
    const monthStart = chicagoMonthStart()

    const { data, error } = await supabase
      .from("energy_monthly")
      .select("month_local, energy_cost, total_with_base_charge, kwh")
      .eq("site_id", SITE_ID)
      .eq("month_local", monthStart)
      .maybeSingle()
    if (error) throw error

    // Before any energy is logged this month, only the standing customer
    // charge has accrued.
    return NextResponse.json({
      ok: true,
      month: monthStart.slice(0, 7),
      energy_cost: data ? Number(data.energy_cost) : 0,
      total_with_base_charge: data ? Number(data.total_with_base_charge) : MONTHLY_CUSTOMER_CHARGE,
      kwh: data ? Number(data.kwh) : 0,
      customer_charge: MONTHLY_CUSTOMER_CHARGE,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
