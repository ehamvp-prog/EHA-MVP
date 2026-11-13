// =====================================================================
// Load the manufacturer blower chart for a model number from the library
// (blower_charts / blower_chart_points). Longest matching model prefix wins;
// the main table (variant '') is preferred over alternates.
// Cached per process for 10 minutes — the library changes rarely.
// =====================================================================

import type { SupabaseClient } from "@supabase/supabase-js"
import { chartMatchesModel, type OemChart } from "@/lib/engine/oem-table"

const TTL_MS = 10 * 60 * 1000
const cache = new Map<string, { at: number; chart: OemChart | null }>()

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "")
const num = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v))

export async function loadOemChart(
  supabase: SupabaseClient,
  model: string | null | undefined,
  equipmentType: "furnace" | "air_handler" | null = null,
): Promise<OemChart | null> {
  if (!model || norm(model).length < 4) return null
  const key = `${norm(model)}|${equipmentType ?? ""}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.chart

  // Narrow by the first 4 characters, then pick the longest prefix match.
  const head = norm(model).slice(0, 4)
  let q = supabase
    .from("blower_charts")
    .select(
      "id, brand, family, model_pattern, motor_type, checked, default_taps, source_url, variant, equipment_type, input_btuh, output_btuh, afue_pct, rise_min_f, rise_max_f",
    )
    .ilike("model_pattern", `${head}%`)
  if (equipmentType) q = q.eq("equipment_type", equipmentType)
  const { data: charts, error } = await q
  if (error || !charts?.length) {
    cache.set(key, { at: Date.now(), chart: null })
    return null
  }
  const best = charts
    .filter((c) => chartMatchesModel(String(c.model_pattern), model))
    .sort((a, b) => {
      const byLen = norm(String(b.model_pattern)).length - norm(String(a.model_pattern)).length
      if (byLen) return byLen
      return (a.variant === "" ? 0 : 1) - (b.variant === "" ? 0 : 1)
    })[0]
  if (!best) {
    cache.set(key, { at: Date.now(), chart: null })
    return null
  }

  const { data: pts } = await supabase
    .from("blower_chart_points")
    .select("tap, tap_order, use_for, static_inwc, cfm, watts")
    .eq("chart_id", best.id)
    .limit(5000)
  const points = (pts ?? [])
    .map((p) => ({
      tap: String(p.tap),
      tapOrder: num(p.tap_order),
      useFor: (p.use_for as string | null) ?? null,
      staticInWc: num(p.static_inwc),
      cfm: Number(p.cfm),
      watts: num(p.watts),
    }))
    .filter((p) => Number.isFinite(p.cfm))

  const chart: OemChart = {
    id: String(best.id),
    brand: String(best.brand),
    family: (best.family as string | null) ?? null,
    modelPattern: String(best.model_pattern),
    motorType: (best.motor_type as string | null) ?? null,
    checked: !!best.checked,
    defaultTaps: (best.default_taps as Record<string, string> | null) ?? null,
    hasWatts: points.some((p) => p.watts != null),
    sourceUrl: String(best.source_url),
    points,
    ratings: {
      inputBtuh: num(best.input_btuh),
      outputBtuh: num(best.output_btuh),
      afuePct: num(best.afue_pct),
      riseMinF: num(best.rise_min_f),
      riseMaxF: num(best.rise_max_f),
    },
  }
  cache.set(key, { at: Date.now(), chart })
  return chart
}

/** Attach the matched chart to a system_profile row for the engine. */
export async function withOemChart<T extends Record<string, unknown> | null>(
  supabase: SupabaseClient,
  profile: T,
): Promise<T> {
  if (!profile) return profile
  const model = (profile.blower_model as string | null | undefined) ?? null
  const type = profile.blower_type === "air_handler" ? "air_handler" : profile.blower_type === "furnace" ? "furnace" : null
  const chart = await loadOemChart(supabase, model, type).catch(() => null)
  return { ...fillRatingsFromChart(profile, chart), oem_chart: chart }
}

/**
 * Furnace ratings left blank in Setup are filled from the manufacturer chart
 * (input, AFUE, rise range). In memory only — Setup values always win. The
 * returned `ratings_from_chart` lists which fields came from the chart.
 */
export function fillRatingsFromChart<T extends Record<string, unknown>>(
  profile: T,
  chart: OemChart | null,
): T & { ratings_from_chart: string[] } {
  const filled: string[] = []
  const out: Record<string, unknown> = { ...profile }
  const r = chart?.ratings
  const blank = (k: string) => out[k] == null || out[k] === ""
  if (r && profile.blower_type !== "air_handler") {
    const set = (k: string, v: number | null) => {
      if (v != null && blank(k)) {
        out[k] = v
        filled.push(k)
      }
    }
    set("furnace_input_nameplate_btuh", r.inputBtuh)
    set("furnace_afue_rated_pct", r.afuePct)
    if (blank("furnace_rise_min_f") && blank("furnace_rise_max_f") && r.riseMinF != null && r.riseMaxF != null) {
      set("furnace_rise_min_f", r.riseMinF)
      set("furnace_rise_max_f", r.riseMaxF)
    }
  }
  return { ...(out as T), ratings_from_chart: filled }
}
