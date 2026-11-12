// Verifies the furnace power-trace decoder and cycle folding.
// Run: node scripts/verify-furnace-sequence.mjs
import {
  decodeFurnaceStep,
  foldHeatCycles,
  DEFAULT_FURNACE_SIGNATURE,
  SHORT_CYCLE_MIN_S,
} from "../lib/engine/heating/furnace-sequence.ts"

let pass = 0
let fail = 0
function check(name, got, want) {
  const ok = got === want
  if (ok) pass++
  else fail++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  →  got=${got} want=${want}`)
}

// A commissioned two-stage signature (plausible numbers for a GM9S-class
// furnace on a 120 V EM channel; real values come from commissioning).
const SIG = {
  ...DEFAULT_FURNACE_SIGNATURE,
  idle_max_w: 15,
  fan_only_w: 77, // this site's continuous-fan draw (measured 10-21)
  inducer_only_w: 95,
  ignition_min_w: 350,
  burn_low_w: 260,
  burn_high_w: 320,
  burn_single_w: null,
  cooling_blower_w: 248, // this site's cooling-tap draw (measured Aug)
  commissioned: true,
}

const s = (furnaceWatts, riseF = null, condenserWatts = 0) => ({ furnaceWatts, riseF, condenserWatts })

// --- Stage decoding, one step at a time ---------------------------------
let r = decodeFurnaceStep(null, s(2, 0), SIG)
check("2 W = idle", r.stage, "idle")

r = decodeFurnaceStep("idle", s(96, 0), SIG)
check("inducer alone after idle = prepurge", r.stage, "prepurge")

r = decodeFurnaceStep("prepurge", s(480, 0), SIG)
check("HSI spike = ignition", r.stage, "ignition")
check("  burner not yet on", r.burnerOn, false)

r = decodeFurnaceStep("ignition", s(262, 4), SIG)
check("burn-low band = burn", r.stage, "burn")
check("  fire = low", r.fire, "low")
check("  burnerOn", r.burnerOn, true)
check("  blowerOn", r.blowerOn, true)

r = decodeFurnaceStep("burn", s(318, 42), SIG)
check("burn-high band = burn/high", `${r.stage}/${r.fire}`, "burn/high")

r = decodeFurnaceStep("burn", s(78, 30), SIG)
check("fan band + hot duct after burn = post_purge", r.stage, "post_purge")
check("  burner off", r.burnerOn, false)

r = decodeFurnaceStep("post_purge", s(77, 1), SIG)
check("fan band, duct cooled = fan_only", r.stage, "fan_only")

r = decodeFurnaceStep("fan_only", s(77, 1), SIG)
check("fan band from fan_only stays fan_only", r.stage, "fan_only")

// THE 40 W BUG: in cooling-era code, >40 W meant "blower on". The inducer
// alone exceeds that with the blower OFF. The decoder must NOT say air is
// moving during prepurge.
r = decodeFurnaceStep("idle", s(96, 0), SIG)
check("prepurge: blowerOn=false (inducer is not the blower)", r.blowerOn, false)

// Condenser on → it's the AC's blower, never a heat stage.
r = decodeFurnaceStep("idle", s(250, -18, 1900), SIG)
check("condenser on = cooling_blower", r.stage, "cooling_blower")

// Null reading.
r = decodeFurnaceStep("burn", s(null, 40), SIG)
check("no reading = unknown", r.stage, "unknown")
check("  confidence none", r.confidence, "none")

// Uncommissioned: generic bands still name the big stages.
r = decodeFurnaceStep("idle", s(2, 0))
check("uncommissioned idle", r.stage, "idle")
r = decodeFurnaceStep("idle", s(420, 0))
check("uncommissioned ignition", r.stage, "ignition")
r = decodeFurnaceStep("ignition", s(225, 30))
check("uncommissioned burn (single band)", `${r.stage}/${r.fire}`, "burn/single")
check("  confidence flagged", r.confidence, "uncommissioned")

// --- Cycle folding ------------------------------------------------------
// 5 s samples: prepurge 30 s, ignition 30 s, burn 12 min (low 4, high 8),
// post-purge 90 s, idle.
const seq = []
let t = 0
const push = (stage, fire, n) => {
  for (let k = 0; k < n; k++) {
    seq.push({ at: new Date(t * 1000).toISOString(), stage, fire, seconds: 5 })
    t += 5
  }
}
push("idle", "unknown", 6)
push("prepurge", "unknown", 6)
push("ignition", "unknown", 6)
push("burn", "low", 48)
push("burn", "high", 96)
push("post_purge", "unknown", 18)
push("idle", "unknown", 6)
// a short cycle: ignition, 3 min burn, post purge
push("ignition", "unknown", 6)
push("burn", "high", 36)
push("post_purge", "unknown", 12)
push("idle", "unknown", 3)

const cycles = foldHeatCycles(seq)
check("two cycles folded", cycles.length, 2)
check("cycle 1 burn seconds", cycles[0].burn_seconds, 720)
check("cycle 1 low fire seconds", cycles[0].low_fire_seconds, 240)
check("cycle 1 high fire seconds", cycles[0].high_fire_seconds, 480)
check("cycle 1 post-purge seconds", cycles[0].post_purge_seconds, 90)
check("cycle 1 ignitions", cycles[0].ignitions, 1)
check("cycle 1 not short", cycles[0].short_cycle, false)
check("cycle 2 is short (<5 min)", cycles[1].short_cycle, true)
check(`short-cycle threshold is 5 min`, SHORT_CYCLE_MIN_S, 300)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
