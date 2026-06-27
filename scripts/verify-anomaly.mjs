// Verifies the Anomaly Color Layer logic against synthetic baselines.
// Mirrors lib/engine/anomaly.ts (kept in sync intentionally for a standalone
// node check without a TS build step).

const TEMP_BIN_F = 5
const MIN_SAMPLES = 12
const HEALTHY_PERCENTILE = 0.75
const BASE = { green: 0.08, yellow: 0.15, orange: 0.25 }
const WIDEN = { high: 1.0, medium: 1.3, low: 1.7 }
const RUNNING_WATTS_MIN = 200

function percentile(s, p) {
  if (s.length === 0) return NaN
  if (s.length === 1) return s[0]
  const idx = p * (s.length - 1)
  const lo = Math.floor(idx), hi = Math.ceil(idx)
  if (lo === hi) return s[lo]
  return s[lo] * (1 - (idx - lo)) + s[hi] * (idx - lo)
}

function assess({ liveEer, totalWatts, outdoorTempF, weatherConfidence, baseline }) {
  if (totalWatts == null || totalWatts < RUNNING_WATTS_MIN) return { color: "idle" }
  if (liveEer == null) return { color: "unknown" }
  let inBin, conditioned = true
  if (outdoorTempF == null) {
    conditioned = false
    inBin = baseline.map((s) => s.liveEer).filter((e) => e != null && e > 0)
  } else {
    inBin = baseline
      .filter((s) => s.outdoorTempF != null && s.liveEer != null && s.liveEer > 0 &&
        Math.abs(s.outdoorTempF - outdoorTempF) <= TEMP_BIN_F)
      .map((s) => s.liveEer)
  }
  if (inBin.length < MIN_SAMPLES) return { color: "learning", n: inBin.length }
  const sorted = [...inBin].sort((a, b) => a - b)
  const baselineEer = percentile(sorted, HEALTHY_PERCENTILE)
  const dev = Math.max(0, (baselineEer - liveEer) / baselineEer)
  const conf = !conditioned ? "low" : (weatherConfidence ?? "medium")
  const w = WIDEN[conf]
  const t = { green: BASE.green * w, yellow: BASE.yellow * w, orange: BASE.orange * w }
  let color
  if (dev < t.green) color = "green"
  else if (dev < t.yellow) color = "yellow"
  else if (dev < t.orange) color = "orange"
  else color = "red"
  let capped = false
  if (conf === "low" && color === "red") { color = "orange"; capped = true }
  return { color, dev: +(dev * 100).toFixed(1), baselineEer: +baselineEer.toFixed(2), capped }
}

// Build a healthy baseline at ~95F: 20 readings, EER clustered ~12 (p75 ≈ 12).
const healthy95 = []
for (let i = 0; i < 20; i++) healthy95.push({ outdoorTempF: 93 + (i % 5), liveEer: 11.5 + (i % 4) * 0.35 })
const p75 = (() => { const s = healthy95.map((x) => x.liveEer).sort((a, b) => a - b); return percentile(s, 0.75) })()

let pass = 0, fail = 0
function check(label, got, want) {
  const ok = got === want
  console.log(`[v0] ${ok ? "PASS" : "FAIL"} ${label}: got ${got} want ${want}`)
  ok ? pass++ : fail++
}

console.log(`[v0] healthy p75 baseline EER = ${p75.toFixed(2)}`)

// Color paths at high confidence (baseline ~12.3)
check("at baseline -> green", assess({ liveEer: 12.3, totalWatts: 3400, outdoorTempF: 95, weatherConfidence: "high", baseline: healthy95 }).color, "green")
check("6% drop -> green", assess({ liveEer: 12.3 * 0.94, totalWatts: 3400, outdoorTempF: 95, weatherConfidence: "high", baseline: healthy95 }).color, "green")
check("11% drop -> yellow", assess({ liveEer: 12.3 * 0.89, totalWatts: 3400, outdoorTempF: 95, weatherConfidence: "high", baseline: healthy95 }).color, "yellow")
check("20% drop -> orange", assess({ liveEer: 12.3 * 0.80, totalWatts: 3400, outdoorTempF: 95, weatherConfidence: "high", baseline: healthy95 }).color, "orange")
check("35% drop -> red", assess({ liveEer: 12.3 * 0.65, totalWatts: 3400, outdoorTempF: 95, weatherConfidence: "high", baseline: healthy95 }).color, "red")

// Confidence widening: a 20% drop that is orange at high conf becomes yellow at low conf
check("20% drop low-conf widens -> yellow", assess({ liveEer: 12.3 * 0.80, totalWatts: 3400, outdoorTempF: 95, weatherConfidence: "low", baseline: healthy95 }).color, "yellow")

// Severity cap: a severe 45% drop is red at high conf but capped to orange at low conf
check("45% drop high-conf -> red", assess({ liveEer: 12.3 * 0.55, totalWatts: 3400, outdoorTempF: 95, weatherConfidence: "high", baseline: healthy95 }).color, "red")
const capRes = assess({ liveEer: 12.3 * 0.20, totalWatts: 3400, outdoorTempF: 95, weatherConfidence: "low", baseline: healthy95 })
check("80% drop low-conf -> capped orange", capRes.color, "orange")
check("  cap flag set", capRes.capped, true)

// Edge states
check("not running -> idle", assess({ liveEer: 12.3, totalWatts: 0, outdoorTempF: 95, weatherConfidence: "high", baseline: healthy95 }).color, "idle")
check("running no EER -> unknown", assess({ liveEer: null, totalWatts: 3400, outdoorTempF: 95, weatherConfidence: "high", baseline: healthy95 }).color, "unknown")
check("thin history -> learning", assess({ liveEer: 12.3, totalWatts: 3400, outdoorTempF: 95, weatherConfidence: "high", baseline: healthy95.slice(0, 5) }).color, "learning")
// Outdoor temp far from baseline bin -> no comparable samples -> learning
check("far temp bin -> learning", assess({ liveEer: 12.3, totalWatts: 3400, outdoorTempF: 60, weatherConfidence: "high", baseline: healthy95 }).color, "learning")
// No outdoor temp -> unconditioned, forced low confidence, still computes
check("no outdoor temp -> still assessable", ["green", "yellow", "orange"].includes(assess({ liveEer: 12.3, totalWatts: 3400, outdoorTempF: null, weatherConfidence: "high", baseline: healthy95 }).color), true)

console.log(`\n[v0] anomaly results: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
