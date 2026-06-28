// Verifies the corroborated system-state logic across every path.
// Mirrors lib/engine/system-state.ts thresholds. Run: node scripts/verify-system-state.mjs
import { deriveSystemState } from "../lib/engine/system-state.ts"

let pass = 0
let fail = 0
function check(name, got, want) {
  const ok = got === want
  if (ok) pass++
  else fail++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  →  got=${got} want=${want}`)
}
function faultCodes(r) {
  return r.faults.map((f) => f.code).sort().join(",")
}

// 1. Compressor on, blower on, no supply sensor → cooling, no fault.
let r = deriveSystemState({ condenserTotalWatts: 1884, blowerWatts: 421, returnTempF: 75.8, supplyTempF: null, staticInWc: 0.5 })
check("compressor+blower (no supply) = cooling", r.state, "cooling")
check("  no faults", faultCodes(r), "")

// 2. THE LIVE BUG CASE: condenser 0, blower 75, no supply sensor → fan_only, NO fault.
r = deriveSystemState({ condenserTotalWatts: 0, blowerWatts: 75.4, returnTempF: 64.9, supplyTempF: null, staticInWc: 0.13 })
check("condenser off + blower only = fan_only", r.state, "fan_only")
check("  NOT a fault", faultCodes(r), "")
check("  running=false (not scored)", r.running, false)

// 3. Everything off → off.
r = deriveSystemState({ condenserTotalWatts: 0, blowerWatts: 0, returnTempF: 72, supplyTempF: null, staticInWc: 0 })
check("all off = off", r.state, "off")

// 4. Compressor on but blower reads 0 → fault (blower_no_power).
r = deriveSystemState({ condenserTotalWatts: 1800, blowerWatts: 0, returnTempF: 75, supplyTempF: 55, staticInWc: 0.5 })
check("compressor on, blower 0 = fault", r.state, "fault")
check("  blower_no_power flagged", faultCodes(r), "blower_no_power")

// 5. Real delta-T proves cooling but condenser reads 0 → fault (condenser_no_power).
r = deriveSystemState({ condenserTotalWatts: 0, blowerWatts: 400, returnTempF: 75, supplyTempF: 56, staticInWc: 0.5 })
check("delta-T cooling, condenser 0 = fault", r.state, "fault")
check("  condenser_no_power flagged", faultCodes(r), "condenser_no_power")

// 6. Compressor on, temps present, but tiny delta-T → warn (no_delta_t), still cooling.
r = deriveSystemState({ condenserTotalWatts: 1800, blowerWatts: 400, returnTempF: 75, supplyTempF: 73, staticInWc: 0.5 })
check("compressor on, no delta-T = cooling (warn)", r.state, "cooling")
check("  no_delta_t warned", faultCodes(r), "no_delta_t")

// 7. Compressor on, blower on, static ~0 → fault (low_static).
r = deriveSystemState({ condenserTotalWatts: 1800, blowerWatts: 400, returnTempF: 75, supplyTempF: 55, staticInWc: 0.01 })
check("cooling + near-zero static = fault", r.state, "fault")
check("  low_static flagged", faultCodes(r), "low_static")

// 8. Condenser sensor offline (null) but real delta-T → cooling, no false fault.
r = deriveSystemState({ condenserTotalWatts: null, blowerWatts: 400, returnTempF: 75, supplyTempF: 55, staticInWc: 0.5 })
check("condenser null + delta-T = cooling", r.state, "cooling")
check("  no condenser fault on null", faultCodes(r), "")

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
