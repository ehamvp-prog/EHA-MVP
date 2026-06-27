// =====================================================================
// GET /api/cost/summary
// Returns the month-to-date accumulated cost (from the latest persisted
// row) plus the fixed monthly customer charge, for the dashboard.
// =====================================================================

import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { SITE_ID } from "@/lib/compute-reading"

export const dynamic = "force-dynamic"

const MONTHLY_CUSTOMER_CHARGE = 14.25
const CST_OFFSET_MS = 6 * 60 * 60 * 1000

function cstMonthKey(iso: string): string {
  const cst = new Date(new Date(iso).getTime() - CST_OFFSET_MS)
  return `${cst.getUTCFullYear()}-${String(cst.getUTCMonth() + 1).padStart(2, "0")}`
}

export async function GET() {
  try {
    const supabase = createAdminClient()
    const { data: rows } = await supabase
      .from("computed_readings")
      .select("reading_at, accumulated_cost")
      .eq("site_id", SITE_ID)
      .order("reading_at", { ascending: false })
      .limit(1)

    const last = rows?.[0] ?? null
    const nowMonth = cstMonthKey(new Date().toISOString())
    const sameMonth = last != null && cstMonthKey(last.reading_at) === nowMonth

    return NextResponse.json({
      ok: true,
      month: nowMonth,
      // If the latest row is from a prior month, this month has only
      // accrued the standing customer charge so far.
      accumulated_cost: sameMonth
        ? Number(last!.accumulated_cost ?? MONTHLY_CUSTOMER_CHARGE)
        : MONTHLY_CUSTOMER_CHARGE,
      customer_charge: MONTHLY_CUSTOMER_CHARGE,
      last_reading_at: last?.reading_at ?? null,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
