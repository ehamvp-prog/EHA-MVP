// =====================================================================
// GET /api/savings/summary
// Measured savings for the current Central-time month, read from the
// savings_monthly view (derived from real power data, not the deprecated
// automation_journal.est_savings_usd formula). All dollar columns are
// coalesced to numbers server-side in the view, so nulls never surface.
// =====================================================================

import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { SITE_ID } from "@/lib/compute-reading"
import { chicagoMonthStartISO } from "@/lib/chicago-time"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const supabase = createAdminClient()
    const monthStart = chicagoMonthStartISO()

    const { data, error } = await supabase
      .from("savings_monthly")
      .select("month_local, net_savings_usd, gross_savings_usd, costs_usd, actions, unmeasurable_actions")
      .eq("site_id", SITE_ID)
      .eq("month_local", monthStart)
      .maybeSingle()
    if (error) throw error

    return NextResponse.json({
      ok: true,
      month: monthStart.slice(0, 7),
      net_savings_usd: data ? Number(data.net_savings_usd) : 0,
      gross_savings_usd: data ? Number(data.gross_savings_usd) : 0,
      costs_usd: data ? Number(data.costs_usd) : 0,
      actions: data ? Number(data.actions) : 0,
      unmeasurable_actions: data ? Number(data.unmeasurable_actions) : 0,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
