// =====================================================================
// GET /api/savings/daily
// Per-day measured savings for the current Central-time month, from the
// savings_daily view. Feeds the cumulative net-savings line in the Savings
// section. Ordered oldest→newest so the client can accumulate directly.
// All dollar/energy columns are coalesced to numbers in the view.
// =====================================================================

import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { SITE_ID } from "@/lib/compute-reading"
import { chicagoMonthStartISO, chicagoTodayISO } from "@/lib/chicago-time"

export const dynamic = "force-dynamic"

type Row = {
  day_local: string
  net_savings_usd: number | string | null
  gross_savings_usd: number | string | null
  costs_usd: number | string | null
  kwh_shifted_off_peak: number | string | null
  actions: number | string | null
  unmeasurable_actions: number | string | null
}

export async function GET() {
  try {
    const supabase = createAdminClient()
    const monthStart = chicagoMonthStartISO()
    const today = chicagoTodayISO()

    const { data, error } = await supabase
      .from("savings_daily")
      .select(
        "day_local, net_savings_usd, gross_savings_usd, costs_usd, kwh_shifted_off_peak, actions, unmeasurable_actions",
      )
      .eq("site_id", SITE_ID)
      .gte("day_local", monthStart)
      .lte("day_local", today)
      .order("day_local", { ascending: true })
    if (error) throw error

    const days = ((data ?? []) as Row[]).map((r) => ({
      day: r.day_local,
      net: Number(r.net_savings_usd ?? 0),
      gross: Number(r.gross_savings_usd ?? 0),
      costs: Number(r.costs_usd ?? 0),
      kwhShifted: Number(r.kwh_shifted_off_peak ?? 0),
      actions: Number(r.actions ?? 0),
      unmeasurable: Number(r.unmeasurable_actions ?? 0),
    }))

    return NextResponse.json({ ok: true, month: monthStart.slice(0, 7), days })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
