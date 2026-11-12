// Replays a real 5-second furnace trace from Josh's GM9S80 (Nov 2026) through
// the measured-band decoder and the cycle folder.
// Run: node scripts/verify-furnace-bands.mjs
import { decodeFurnaceStep, foldHeatCycles } from "../lib/engine/heating/furnace-sequence.ts"

const SIG = {
  idle_max_w: 15, fan_only_w: 78, inducer_only_w: 132, ignition_min_w: 188, ignition_w: 205,
  burn_low_w: null, burn_high_w: null, burn_single_w: 353, post_purge_blower_w: 288,
  cooling_blower_w: 248, tolerance_pct: 0.08, commissioned: true,
}

// [watts, rise °F] every 5 s. 10 W idle → inducer → igniter → gas on, blower
// delay → burn ~352 W for ~14.5 min → valve off → heat-off blower → idle.
const trace = [
  ...Array(6).fill([10, 0]),
  [121, 0], [131, 0], [132, 0],
  [219, 0], [200, 0], [198, 0], [207, 0],
  ...Array(6).fill([142, 2]),
  [341, 6], [358, 15], ...Array(170).fill([352, 35]),
  [341, 34], [338, 33], [340, 33], [339, 32],
  ...Array(15).fill([288, 25]),
  [109, 12], ...Array(10).fill([10, 5]),
]

let pass = 0, fail = 0
const check = (name, ok, got) => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}  →  ${got}`) }

let prev = null
const t0 = Date.parse("2026-11-10T14:46:27Z")
const samples = trace.map(([w, rise], i) => {
  const r = decodeFurnaceStep(prev, { furnaceWatts: w, condenserWatts: 0, riseF: rise }, SIG)
  prev = r.stage
  return { at: new Date(t0 + i * 5000).toISOString(), stage: r.stage, fire: r.fire, seconds: 5, w, burnerOn: r.burnerOn }
})

const stageAt = (w) => samples.find((s) => s.w === w)?.stage
check("131 W inducer = prepurge", stageAt(131) === "prepurge", stageAt(131))
check("219 W = ignition", stageAt(219) === "ignition", stageAt(219))
check("142 W after ignition = burn (blower delay)", stageAt(142) === "burn", stageAt(142))
check("352 W = burn", stageAt(352) === "burn", stageAt(352))
check("288 W after burn = post_purge", stageAt(288) === "post_purge", stageAt(288))
check("idle at end", samples.at(-1).stage === "idle", samples.at(-1).stage)
check("never 'unknown' during the steady burn", !samples.some((s) => s.w === 352 && s.stage !== "burn"), "ok")

const cycles = foldHeatCycles(samples)
check("one cycle", cycles.length === 1, cycles.length)
const c = cycles[0]
check("one ignition", c.ignitions === 1, c.ignitions)
check("burn ≈ 15 min", c.burn_seconds >= 880 && c.burn_seconds <= 940, c.burn_seconds)
check("not a short cycle", c.short_cycle === false, c.short_cycle)
check("post-purge ≈ 75 s", c.post_purge_seconds >= 60 && c.post_purge_seconds <= 90, c.post_purge_seconds)

// Cooling blower at 248 W with the condenser running is never heat.
const cool = decodeFurnaceStep(null, { furnaceWatts: 250, condenserWatts: 1900, riseF: -18 }, SIG)
check("cooling blower ignored", cool.stage === "cooling_blower", cool.stage)
// Cooling coast (condenser just stopped, 248 W, cold coil) is not a burn or ignition.
const coast = decodeFurnaceStep("cooling_blower", { furnaceWatts: 248, condenserWatts: 0, riseF: -12 }, SIG)
check("cooling coast not heat", !["burn", "ignition", "prepurge"].includes(coast.stage), coast.stage)
// Fan circulation 78 W.
const fan = decodeFurnaceStep("idle", { furnaceWatts: 78, condenserWatts: 0, riseF: 0 }, SIG)
check("78 W = fan only", fan.stage === "fan_only", fan.stage)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
