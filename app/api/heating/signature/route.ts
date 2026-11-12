// =====================================================================
// /api/heating/signature
//   GET   current furnace signature (the watt bands the decoder uses)
//   POST  learn it from this furnace's own recent data and save it
//
// Learning, in plain terms:
//   1. Find the most recent minute the furnace was clearly heating
//      (condenser off, supply 20°F+ hotter than return).
//   2. Pull the 5-second furnace power around it and split it into flat
//      steps. The long flat step in the middle is the burn.
//   3. Walking back from the burn: the steps are blower-delay (gas lit,
//      blower not on yet), igniter, inducer. Walking forward: the last
//      flat step before idle is the blower running the heat out.
//   4. Fan-only and the cooling blower come from the minute history.
// Nothing here talks to the furnace or thermostat.
// =====================================================================

import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { SITE_ID } from "@/lib/compute-reading"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const IDLE_W = 20

type Step = { start: number; end: number; w: number; n: number }

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}

// Split a power trace into runs of near-equal watts (within 6 % / 8 W).
function steps(ws: number[]): Step[] {
  const out: Step[] = []
  let cur: { start: number; vals: number[] } | null = null
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]
    if (cur) {
      const m = median(cur.vals)
      if (Math.abs(w - m) <= Math.max(8, m * 0.06)) {
        cur.vals.push(w)
        continue
      }
      out.push({ start: cur.start, end: i - 1, w: median(cur.vals), n: cur.vals.length })
    }
    cur = { start: i, vals: [w] }
  }
  if (cur) out.push({ start: cur.start, end: ws.length - 1, w: median(cur.vals), n: cur.vals.length })
  return out
}

function mode(values: number[], bin = 2): number | null {
  if (!values.length) return null
  const counts = new Map<number, number>()
  for (const v of values) {
    const k = Math.round(v / bin) * bin
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

export async function GET() {
  const supabase = createAdminClient()
  const { data, error } = await supabase.from("system_profile").select("furnace_signature").eq("site_id", SITE_ID).maybeSingle()
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, signature: data?.furnace_signature ?? null })
}

export async function POST() {
  try {
    const supabase = createAdminClient()
    const since = new Date(Date.now() - 14 * 86400000).toISOString()

    // 1. Latest clear heating minute.
    const { data: sens } = await supabase
      .from("sensor_minutes")
      .select("minute, supply_temp_f, return_temp_f")
      .eq("site_id", SITE_ID)
      .gte("minute", since)
      .order("minute", { ascending: false })
      .limit(20160)
    const { data: energy } = await supabase
      .from("energy_minutes")
      .select("minute, cond_watts, blower_watts")
      .eq("site_id", SITE_ID)
      .gte("minute", since)
      .order("minute", { ascending: false })
      .limit(20160)

    const eByMin = new Map((energy ?? []).map((e) => [String(e.minute), e]))
    let anchor: string | null = null
    const fanVals: number[] = []
    const coolVals: number[] = []
    for (const s of sens ?? []) {
      const e = eByMin.get(String(s.minute))
      if (!e || s.supply_temp_f == null || s.return_temp_f == null) continue
      const rise = Number(s.supply_temp_f) - Number(s.return_temp_f)
      const cond = Number(e.cond_watts ?? 0)
      const bw = Number(e.blower_watts ?? 0)
      if (!anchor && cond < 50 && rise >= 20 && bw > 150) anchor = String(s.minute)
      if (cond < 50 && Math.abs(rise) < 3 && bw > 30 && bw < 150) fanVals.push(bw)
      if (cond >= 100 && bw > 100) coolVals.push(bw)
    }
    if (!anchor) {
      return NextResponse.json(
        { ok: false, error: "No furnace run found in the last 14 days. Run the heat for 15 minutes, then try again." },
        { status: 400 },
      )
    }

    // 2. 5-second furnace power around that minute.
    const from = new Date(Date.parse(anchor) - 40 * 60000).toISOString()
    const to = new Date(Date.parse(anchor) + 40 * 60000).toISOString()
    const { data: raw, error } = await supabase
      .from("telemetry")
      .select("device_id, device_type, payload, received_at")
      .eq("site_id", SITE_ID)
      .gte("received_at", from)
      .lte("received_at", to)
      .order("received_at", { ascending: true })
      .limit(5000)
    if (error) throw new Error(error.message)
    const ws = (raw ?? [])
      .filter((r) => /ahu|blower|furnace/i.test(`${r.device_id} ${r.device_type}`))
      .map((r) => Number((r.payload as Record<string, unknown>).blower_watts ?? NaN))
      .filter((w) => Number.isFinite(w))
    if (ws.length < 60) throw new Error("Not enough furnace power readings around the last heat run.")

    const st = steps(ws)
    // Burn = the longest step that's above everything else around it.
    const burnIdx = st.reduce((best, s, i) => (s.w > 150 && s.n > (st[best]?.n ?? 0) ? i : best), -1)
    if (burnIdx < 0 || st[burnIdx].n < 24) throw new Error("Couldn't find a steady burn (2 min or longer) in the last heat run.")
    const burn = st[burnIdx]

    // Walk back to idle; keep steps 2+ samples long (skip ramps).
    const before: Step[] = []
    for (let i = burnIdx - 1; i >= 0 && st[i].w > IDLE_W; i--) if (st[i].n >= 2) before.push(st[i])
    // nearest-first: [blower delay], igniter, inducer
    const inducer = before.length ? before[before.length - 1] : null
    const igniter = before.length >= 2 ? before[before.length - 2] : null

    let postBlower: Step | null = null
    for (let i = burnIdx + 1; i < st.length && st[i].w > IDLE_W; i++) if (st[i].n >= 3 && st[i].w < burn.w * 0.95) postBlower = st[i]

    const sig = {
      idle_max_w: 15,
      fan_only_w: mode(fanVals) ?? 80,
      inducer_only_w: inducer ? Math.round(inducer.w) : 90,
      ignition_min_w: igniter ? Math.round(igniter.w * 0.92) : 350,
      ignition_w: igniter ? Math.round(igniter.w) : null,
      burn_low_w: null,
      burn_high_w: null,
      burn_single_w: Math.round(burn.w),
      post_purge_blower_w: postBlower ? Math.round(postBlower.w) : null,
      cooling_blower_w: mode(coolVals),
      tolerance_pct: 0.08,
      commissioned: Boolean(inducer && igniter),
      learned_at: new Date().toISOString(),
      learned_from: anchor,
    }

    const { error: upErr } = await supabase
      .from("system_profile")
      .update({ furnace_signature: sig, updated_at: new Date().toISOString() })
      .eq("site_id", SITE_ID)
    if (upErr) throw new Error(upErr.message)

    return NextResponse.json({ ok: true, signature: sig })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "Learning failed" }, { status: 500 })
  }
}
