// =====================================================================
// GET /api/savings/events
// Per-action measured savings + plain-language explanations, from the
// savings_events view. Keyed by `id`, which matches automation_journal.id,
// so the Automation Journal can enrich each entry with its measured effect,
// confidence, limiting factors, and explanation.
//
// `confidence` drives how the amount is rendered (see the journal component):
//   medium → show amount · low → show softened · none → "No measurable
//   effect" · insufficient_data → "Not enough data to measure".
// `measured_savings_usd` may be negative — pre-cooling spends at off-peak to
// avoid on-peak, and that cost is shown honestly, not as an error.
// =====================================================================

import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { SITE_ID } from "@/lib/compute-reading"

export const dynamic = "force-dynamic"

type Row = {
  id: string
  occurred_at: string
  action_type: string
  measured_savings_usd: number | string | null
  confidence: string | null
  limiting_factors: string[] | null
  explanation: string | null
}

export async function GET() {
  try {
    const supabase = createAdminClient()

    const { data, error } = await supabase
      .from("savings_events")
      .select("id, occurred_at, action_type, measured_savings_usd, confidence, limiting_factors, explanation")
      .eq("site_id", SITE_ID)
      .order("occurred_at", { ascending: false })
      .limit(500)
    if (error) throw error

    const events = ((data ?? []) as Row[]).map((r) => {
      // Spec v2.3 §9: comfort_adjust drives toward the household's target;
      // reaching comfort is the product working, not a saving. It is NEVER
      // attributed savings, enforced here at read time so no future rebuild of
      // savings_events can leak service-withdrawal dollars into the ledger.
      const excluded = r.action_type === "comfort_adjust"
      return {
        id: String(r.id),
        occurred_at: r.occurred_at,
        action_type: r.action_type,
        measured_savings_usd: excluded ? 0 : r.measured_savings_usd == null ? null : Number(r.measured_savings_usd),
        confidence: excluded ? "excluded" : (r.confidence ?? "none"),
        limiting_factors: Array.isArray(r.limiting_factors) ? r.limiting_factors : [],
        explanation: excluded
          ? "Excluded per spec §9 — moving toward your comfort target is the system working, not energy saved."
          : (r.explanation ?? null),
      }
    })

    return NextResponse.json({ ok: true, events })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
