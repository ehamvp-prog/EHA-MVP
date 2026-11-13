// =====================================================================
// GET /api/airflow/chart
// Which manufacturer blower chart the app matched to the entered model,
// which taps it uses for heat and cooling (and how each was settled), and
// which furnace ratings it filled in because Setup was blank.
// =====================================================================

import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { SITE_ID } from "@/lib/compute-reading"
import { loadOemChart, fillRatingsFromChart } from "@/lib/airflow/oem-chart"
import { chartTaps, resolveTap, tapSourceLabel } from "@/lib/engine/oem-table"

export const dynamic = "force-dynamic"

export async function GET() {
  const supabase = createAdminClient()
  const { data: p, error } = await supabase
    .from("system_profile")
    .select(
      "blower_model, blower_type, blower_speed_tap, heat_blower_speed_tap, heat_cfm, furnace_input_nameplate_btuh, furnace_afue_rated_pct, furnace_rise_min_f, furnace_rise_max_f",
    )
    .eq("site_id", SITE_ID)
    .maybeSingle()
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  const model = (p?.blower_model as string | null) ?? null
  const type = p?.blower_type === "air_handler" ? "air_handler" : p?.blower_type === "furnace" ? "furnace" : null
  const chart = await loadOemChart(supabase, model, type)
  const { count } = await supabase.from("blower_charts").select("id", { count: "exact", head: true })

  if (!chart) {
    return NextResponse.json({ ok: true, model, matched: false, library_charts: count ?? null })
  }

  const describe = (typed: string | null, mode: "heat" | "cool") => {
    const exact = resolveTap(chart, typed, { exactOnly: true })
    if (exact) return { tap: exact, how: tapSourceLabel("entered"), guess: false }
    const d = chart.defaultTaps ?? {}
    const def = mode === "heat" ? d.heat : (d.cool ?? d.cool_low ?? d.cool_high)
    const defTap = def ? resolveTap(chart, def) : null
    if (typed && String(typed).trim()) {
      return {
        tap: null,
        how: `"${typed}" isn't printed on this chart (it uses ${chartTaps(chart).slice(0, 3).join(", ")}…)${
          mode === "cool" ? ", so cooling keeps its current airflow estimate. Enter the tap as printed on the board to use the chart" : ""
        }`,
        guess: true,
        default: defTap,
      }
    }
    return { tap: defTap, how: tapSourceLabel(chart.hasWatts && mode === "cool" ? "matched_watts" : "factory_default"), guess: true }
  }

  const filled = fillRatingsFromChart((p ?? {}) as Record<string, unknown>, chart)
  return NextResponse.json({
    ok: true,
    model,
    matched: true,
    library_charts: count ?? null,
    chart: {
      brand: chart.brand,
      family: chart.family,
      model_pattern: chart.modelPattern,
      motor_type: chart.motorType,
      checked: chart.checked,
      has_watts: chart.hasWatts,
      taps: chartTaps(chart),
      default_taps: chart.defaultTaps,
      source_url: chart.sourceUrl,
      ratings: chart.ratings ?? null,
    },
    heat: p?.heat_cfm != null ? { tap: null, how: "using the heat CFM entered in Setup", guess: false } : describe((p?.heat_blower_speed_tap as string | null) ?? null, "heat"),
    cool: describe((p?.blower_speed_tap as string | null) ?? null, "cool"),
    ratings_from_chart: filled.ratings_from_chart,
  })
}
