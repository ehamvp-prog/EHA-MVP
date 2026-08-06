// =====================================================================
// One-off backfill: recompute historical capacity_btuh, live_eer, and
// measured_seer2_estimate for computed_readings using the SAME engine
// functions the live pipeline uses (psychrometric dry-air mass flow),
// NOT the 4.5 sea-level constant used in the earlier hand backfill.
//
// It reuses each row's already-corrected airflow_cfm and the barometric
// pressure the engine actually used (outdoor_pressure_inhg), so history
// becomes bit-for-bit consistent with rows written going forward.
//
// Run:
//   node --env-file=/vercel/share/.env.project \
//     node_modules/.bin/tsx scripts/backfill-capacity-psychrometric.mjs [--commit]
// Without --commit it is a DRY RUN (computes + reports, writes nothing).
// =====================================================================

import { createClient } from "@supabase/supabase-js"
import { moistAirState } from "../lib/engine/psychrometrics.ts"
import { capacityFromAirSide } from "../lib/engine/capacity.ts"
import { computeEfficiency } from "../lib/engine/seer2.ts"

const COMMIT = process.argv.includes("--commit")
const SITE_ID = "default"
const FALLBACK_P_INHG = 29.92 // engine's standard-fallback pressure

// Profile (system_profile row for 'default'): standard split, factor 0.95.
const EQUIPMENT_CLASS = "standard_split"
const SEER2_FACTOR_OVERRIDE = 0.95

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY")
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })

// Page through the whole table (service role, RLS bypassed).
async function fetchAll() {
  const pageSize = 1000
  let from = 0
  const rows = []
  for (;;) {
    const { data, error } = await db
      .from("computed_readings")
      .select(
        "id, return_temp_f, return_rh, supply_temp_f, supply_rh, airflow_cfm, outdoor_pressure_inhg, total_watts, capacity_btuh, live_eer, measured_seer2_estimate",
      )
      .eq("site_id", SITE_ID)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) break
    rows.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }
  return rows
}

const num = (v) => (v == null ? null : Number(v))

async function main() {
  const rows = await fetchAll()
  console.log(`[v0] fetched ${rows.length} rows`)

  const updates = []
  let skipped = 0
  let maxCapDelta = 0
  let maxEerDelta = 0
  const samples = []

  for (const r of rows) {
    const cfm = num(r.airflow_cfm)
    const pInHg = num(r.outdoor_pressure_inhg) ?? FALLBACK_P_INHG
    const rState = moistAirState(num(r.return_temp_f), num(r.return_rh), pInHg)
    const sState = moistAirState(num(r.supply_temp_f), num(r.supply_rh), pInHg)
    const cap = capacityFromAirSide(cfm, rState, sState)
    if (cap.capacityBtuh == null) {
      skipped++
      continue
    }
    const eff = computeEfficiency(cap.capacityBtuh, num(r.total_watts), EQUIPMENT_CLASS, SEER2_FACTOR_OVERRIDE)

    const oldCap = num(r.capacity_btuh)
    const oldEer = num(r.live_eer)
    if (oldCap != null) maxCapDelta = Math.max(maxCapDelta, Math.abs(oldCap - cap.capacityBtuh))
    if (oldEer != null && eff.liveEer != null) maxEerDelta = Math.max(maxEerDelta, Math.abs(oldEer - eff.liveEer))

    updates.push({
      id: r.id,
      capacity_btuh: cap.capacityBtuh,
      live_eer: eff.liveEer,
      measured_seer2_estimate: eff.measuredSeer2Estimate,
    })
    if (samples.length < 6 && oldCap != null)
      samples.push({ id: r.id, oldCap: Math.round(oldCap), newCap: Math.round(cap.capacityBtuh), oldEer, newEer: eff.liveEer })
  }

  console.log(`[v0] recomputed=${updates.length} skipped(no inputs)=${skipped}`)
  console.log(`[v0] max |Δcapacity| vs stored = ${maxCapDelta.toFixed(1)} BTU/hr`)
  console.log(`[v0] max |Δeer| vs stored       = ${maxEerDelta.toFixed(4)}`)
  console.log(`[v0] samples:`, JSON.stringify(samples, null, 2))

  if (!COMMIT) {
    console.log("[v0] DRY RUN — no writes. Re-run with --commit to persist.")
    return
  }

  // Write back with per-row UPDATE keyed by id (id is GENERATED ALWAYS, so it
  // cannot be upserted). Bounded concurrency keeps it fast without flooding.
  const concurrency = 20
  let written = 0
  for (let i = 0; i < updates.length; i += concurrency) {
    const slice = updates.slice(i, i + concurrency)
    await Promise.all(
      slice.map(async (u) => {
        const { error } = await db
          .from("computed_readings")
          .update({
            capacity_btuh: u.capacity_btuh,
            live_eer: u.live_eer,
            measured_seer2_estimate: u.measured_seer2_estimate,
          })
          .eq("id", u.id)
        if (error) throw new Error(`update id=${u.id} failed: ${error.message}`)
      }),
    )
    written += slice.length
    if (written % 500 < concurrency) console.log(`[v0] wrote ${written}/${updates.length}`)
  }
  console.log(`[v0] DONE — updated ${written} rows`)
}

main().catch((e) => {
  console.error("[v0] FAILED:", e.message)
  process.exit(1)
})
