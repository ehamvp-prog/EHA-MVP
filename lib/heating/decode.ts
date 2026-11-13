// =====================================================================
// Background furnace decode.
//
// The live engine only runs while the app is open. This job runs every
// minute from Supabase pg_cron (POST /api/heating/decode) so every furnace
// cycle is recorded whether or not anyone is looking.
//
// It walks raw telemetry in id order from a saved bookmark, rebuilds the
// "latest reading per device" picture at each furnace power sample, and
// runs the SAME engine the live screen uses. So the stage, rise, delivered
// heat and gas input written here are the numbers the screen would have
// shown at that moment.
//
// Outputs:
//   furnace_samples       the 5-second stage timeline (heat-call stages only)
//   heat_cycles           one row per finished furnace cycle
//   heating_decode_state  bookmark + the cycle still in progress
// =====================================================================

import { withOemChart } from "@/lib/airflow/oem-chart"
import { createAdminClient } from "@/lib/supabase/admin"
import { runEngine, type SystemProfileInputs } from "@/lib/engine"
import { extractHvacInputs, type LatestDevice } from "@/lib/engine/extract"
import {
  SHORT_CYCLE_MIN_S,
  type FurnaceSignature,
  type FurnaceStage,
} from "@/lib/engine/heating/furnace-sequence"

const SITE_ID = "default"
const PAGE_SIZE = 1000
// Raw telemetry is kept 14 days; the first run starts there.
const BACKFILL_DAYS = 14
// A hole in the data longer than this ends whatever cycle was open.
const DATA_GAP_S = 120
// This many seconds outside a heat call closes the cycle. Rides through a
// single odd sample without splitting one burn into two cycles.
const CLOSE_GAP_S = 20
const CALL_STAGES: FurnaceStage[] = ["prepurge", "ignition", "burn", "post_purge"]

interface TelemetryRow extends LatestDevice {
  id: number
}

export interface OpenCycle {
  started_at: string
  ended_at: string
  burn_s: number
  low_s: number
  high_s: number
  post_s: number
  ignitions: number
  last_ign: boolean
  gas_btu: number
  gas_known: boolean
  delivered_btu: number
  delivered_known: boolean
  rise_sum: number
  rise_n: number
  max_rise: number | null
  wh: number
  gap_s: number
}

export interface DecodeResult {
  ok: true
  rows: number
  samples: number
  cycles_closed: number
  caught_up: boolean
  last_id: number | null
  cycle_open: boolean
}

function parseSignature(raw: unknown): FurnaceSignature | null {
  let obj: unknown = raw
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null
  const o = obj as Record<string, unknown>
  const numKeys = ["idle_max_w", "fan_only_w", "inducer_only_w", "ignition_min_w", "tolerance_pct"]
  if (!numKeys.every((k) => typeof o[k] === "number" && Number.isFinite(o[k] as number))) return null
  return o as unknown as FurnaceSignature
}

function newCycle(at: string): OpenCycle {
  return {
    started_at: at,
    ended_at: at,
    burn_s: 0,
    low_s: 0,
    high_s: 0,
    post_s: 0,
    ignitions: 0,
    last_ign: false,
    gas_btu: 0,
    gas_known: true,
    delivered_btu: 0,
    delivered_known: true,
    rise_sum: 0,
    rise_n: 0,
    max_rise: null,
    wh: 0,
    gap_s: 0,
  }
}

function cycleRow(c: OpenCycle, gasRate: number | null, commissioned: boolean) {
  const hasBurn = c.burn_s > 0
  const gas = hasBurn && c.gas_known && c.gas_btu > 0 ? c.gas_btu : null
  const delivered = hasBurn && c.delivered_known && c.delivered_btu > 0 ? c.delivered_btu : null
  return {
    site_id: SITE_ID,
    started_at: c.started_at,
    ended_at: c.ended_at,
    burn_seconds: Math.round(c.burn_s),
    low_fire_seconds: Math.round(c.low_s),
    high_fire_seconds: Math.round(c.high_s),
    post_purge_seconds: Math.round(c.post_s),
    ignitions: c.ignitions,
    short_cycle: hasBurn && c.burn_s < SHORT_CYCLE_MIN_S,
    gas_input_btu: gas,
    delivered_btu: delivered,
    avg_rise_f: c.rise_n > 0 ? Math.round((c.rise_sum / c.rise_n) * 10) / 10 : null,
    max_rise_f: c.max_rise != null ? Math.round(c.max_rise * 10) / 10 : null,
    live_eff_pct: gas != null && delivered != null ? Math.round((delivered / gas) * 1000) / 10 : null,
    gas_cost_usd: gas != null && gasRate != null ? Math.round((gas / 100000) * gasRate * 10000) / 10000 : null,
    electric_kwh: Math.round(c.wh) / 1000,
    confidence: commissioned ? "commissioned" : "uncommissioned",
  }
}

export async function runHeatingDecode(opts: { deadlineMs?: number; maxPages?: number } = {}): Promise<DecodeResult> {
  const supabase = createAdminClient()
  const stopAt = Date.now() + (opts.deadlineMs ?? 20000)
  const maxPages = opts.maxPages ?? 25

  const [{ data: profileRow }, { data: state }] = await Promise.all([
    supabase.from("system_profile").select("*").eq("site_id", SITE_ID).maybeSingle(),
    supabase.from("heating_decode_state").select("*").eq("site_id", SITE_ID).maybeSingle(),
  ])
  // Attach the manufacturer blower chart so heat cycles use chart airflow.
  const profile = await withOemChart(supabase, profileRow as Record<string, unknown> | null)

  const signature = parseSignature((profile as { furnace_signature?: unknown } | null)?.furnace_signature)
  const commissioned = signature?.commissioned === true
  const gasRateRaw = (profile as { gas_rate_per_therm?: number | string | null } | null)?.gas_rate_per_therm
  const gasRate = gasRateRaw == null ? null : Number(gasRateRaw)

  let lastId: number | null = state?.last_telemetry_id != null ? Number(state.last_telemetry_id) : null
  let prevStage: FurnaceStage | null = (state?.last_stage as FurnaceStage | null) ?? null
  let prevRise: number | null = state?.last_rise_f != null ? Number(state.last_rise_f) : null
  let lastSampleAt: string | null = (state?.last_sample_at as string | null) ?? null
  let cur: OpenCycle | null = (state?.open_cycle as OpenCycle | null) ?? null

  // First run: start at the oldest telemetry still on hand.
  if (lastId == null) {
    const since = new Date(Date.now() - BACKFILL_DAYS * 86400000).toISOString()
    const { data: first, error } = await supabase
      .from("telemetry")
      .select("id")
      .eq("site_id", SITE_ID)
      .gte("received_at", since)
      .order("received_at", { ascending: true })
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!first) {
      return { ok: true, rows: 0, samples: 0, cycles_closed: 0, caught_up: true, last_id: null, cycle_open: false }
    }
    lastId = Number(first.id) - 1
  }

  // Seed the "latest reading per device" picture from just before the bookmark.
  const latest = new Map<string, LatestDevice>()
  {
    const { data: seed } = await supabase
      .from("telemetry")
      .select("id, device_id, device_type, payload, recorded_at, received_at")
      .eq("site_id", SITE_ID)
      .lte("id", lastId)
      .order("id", { ascending: false })
      .limit(60)
    for (const r of (seed ?? []) as TelemetryRow[]) {
      if (!latest.has(r.device_id)) latest.set(r.device_id, r)
    }
  }

  const sampleRows: Record<string, unknown>[] = []
  const closed: ReturnType<typeof cycleRow>[] = []
  let rowsSeen = 0
  let samplesSeen = 0
  let caughtUp = false

  const closeCycle = () => {
    if (!cur) return
    // Keep real burns and failed ignitions; drop stray purge-only blips.
    if (cur.burn_s > 0 || cur.ignitions > 0) closed.push(cycleRow(cur, gasRate, commissioned))
    cur = null
  }

  for (let page = 0; page < maxPages && Date.now() < stopAt; page++) {
    const { data, error } = await supabase
      .from("telemetry")
      .select("id, device_id, device_type, payload, recorded_at, received_at")
      .eq("site_id", SITE_ID)
      .gt("id", lastId)
      .order("id", { ascending: true })
      .limit(PAGE_SIZE)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as TelemetryRow[]
    if (rows.length === 0) {
      caughtUp = true
      break
    }

    for (const row of rows) {
      rowsSeen++
      lastId = Number(row.id)
      latest.set(row.device_id, row)

      const devices = Array.from(latest.values())
      // Only the furnace power sample advances the timeline.
      if (extractHvacInputs(devices).matched.blower !== row.device_id) continue

      const at = (row.received_at ?? row.recorded_at) as string | null
      if (!at) continue

      let seconds = 5
      if (lastSampleAt) {
        const dt = (Date.parse(at) - Date.parse(lastSampleAt)) / 1000
        if (dt <= 0) continue // out-of-order duplicate
        if (dt > DATA_GAP_S) {
          closeCycle()
          prevStage = null
          prevRise = null
        } else {
          seconds = Math.min(30, Math.max(1, dt))
        }
      }
      lastSampleAt = at

      const c = runEngine(devices, (profile as SystemProfileInputs) ?? null, {
        readingAt: at,
        prevFurnaceStage: prevStage,
        prevRiseF: prevRise,
        furnaceSignature: signature,
      })
      const stage = c.furnace_stage
      const rise =
        c.supply_temp_f != null && c.return_temp_f != null ? c.supply_temp_f - c.return_temp_f : null
      const inCall = CALL_STAGES.includes(stage)
      samplesSeen++

      if (inCall) {
        if (!cur) cur = newCycle(at)
        cur.ended_at = at
        cur.gap_s = 0
        if (stage === "ignition" && !cur.last_ign) cur.ignitions++
        cur.last_ign = stage === "ignition"
        if (c.blower_watts != null) cur.wh += (c.blower_watts * seconds) / 3600

        if (stage === "burn") {
          cur.burn_s += seconds
          if (c.fire_stage === "low") cur.low_s += seconds
          if (c.fire_stage === "high") cur.high_s += seconds
          if (c.gas_input_btuh != null) cur.gas_btu += (c.gas_input_btuh * seconds) / 3600
          else cur.gas_known = false
          if (rise != null) {
            cur.rise_sum += rise
            cur.rise_n++
            cur.max_rise = cur.max_rise == null ? rise : Math.max(cur.max_rise, rise)
          }
        }
        if (stage === "post_purge") cur.post_s += seconds
        if (stage === "burn" || stage === "post_purge") {
          // Blower still on its on-delay = no air moving, nothing delivered yet
          // (that heat comes out later, during post-purge). Only a missing
          // number WITH air moving makes the cycle's delivered total unknown.
          if (c.delivered_btuh != null) cur.delivered_btu += (c.delivered_btuh * seconds) / 3600
          else if (stage === "burn" && c.airflow_cfm != null) cur.delivered_known = false
        }

        sampleRows.push({
          site_id: SITE_ID,
          at,
          furnace_watts: c.blower_watts,
          condenser_watts:
            c.condenser_watts_leg1 == null && c.condenser_watts_leg2 == null
              ? null
              : (c.condenser_watts_leg1 ?? 0) + (c.condenser_watts_leg2 ?? 0),
          rise_f: rise != null ? Math.round(rise * 10) / 10 : null,
          stage,
          fire: c.fire_stage ?? "unknown",
          seconds: Math.round(seconds),
        })
      } else if (cur) {
        cur.gap_s += seconds
        if (cur.gap_s >= CLOSE_GAP_S) closeCycle()
      }

      prevStage = stage
      prevRise = rise
    }

    if (rows.length < PAGE_SIZE) {
      caughtUp = true
      break
    }
  }

  // Writes. All idempotent, so a re-run after a crash just repeats them.
  for (let i = 0; i < sampleRows.length; i += 500) {
    const { error } = await supabase
      .from("furnace_samples")
      .upsert(sampleRows.slice(i, i + 500), { onConflict: "site_id,at" })
    if (error) throw new Error(`furnace_samples: ${error.message}`)
  }
  if (closed.length > 0) {
    const { error } = await supabase.from("heat_cycles").upsert(closed, { onConflict: "site_id,started_at" })
    if (error) throw new Error(`heat_cycles: ${error.message}`)
  }
  {
    const { error } = await supabase.from("heating_decode_state").upsert(
      {
        site_id: SITE_ID,
        watermark: lastSampleAt,
        last_telemetry_id: lastId,
        last_stage: prevStage,
        last_rise_f: prevRise,
        last_sample_at: lastSampleAt,
        open_cycle: cur,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "site_id" },
    )
    if (error) throw new Error(`heating_decode_state: ${error.message}`)
  }

  return {
    ok: true,
    rows: rowsSeen,
    samples: samplesSeen,
    cycles_closed: closed.length,
    caught_up: caughtUp,
    last_id: lastId,
    cycle_open: cur != null,
  }
}
