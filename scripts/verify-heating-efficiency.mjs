// Verifies delivered-heat capacity, the rise check, and the AFUE grading.
// Run: node scripts/verify-heating-efficiency.mjs
import { moistAirState } from "../lib/engine/psychrometrics.ts"
import { heatingCapacityFromAirSide, checkTemperatureRise } from "../lib/engine/heating/heating-capacity.ts"
import {
  inputBtuhFromClock,
  inputBtuhForFire,
  liveThermalEfficiencyPct,
  expectedSteadyStateBand,
  gradeLiveEfficiency,
  seasonalDeliveredEfficiencyPct,
  GAS_HEATING_VALUE_BTU_PER_CUFT,
} from "../lib/engine/heating/afue.ts"

let pass = 0
let fail = 0
function check(name, got, want) {
  const ok = got === want
  if (ok) pass++
  else fail++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  →  got=${got} want=${want}`)
}
function near(name, got, want, tol) {
  const ok = got != null && Math.abs(got - want) <= tol
  if (ok) pass++
  else fail++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  →  got=${got?.toFixed?.(1) ?? got} want≈${want}±${tol}`)
}

// --- Delivered heat ------------------------------------------------------
const ret = moistAirState(70, 35, 29.92)
let q = heatingCapacityFromAirSide(1000, ret, 120)
check("rise = 50 °F", q.riseF, 50)
near("delivered ≈ 1.08·CFM·rise", q.deliveredBtuh, 54000, 54000 * 0.03)
near("cp moist ≈ 0.242", q.cpMoist, 0.242, 0.003)

q = heatingCapacityFromAirSide(840, moistAirState(68, 40, 29.92), 128)
near("840 CFM × 60 °F ≈ 54k", q.deliveredBtuh, 54400, 54400 * 0.03)

q = heatingCapacityFromAirSide(null, ret, 120)
check("no CFM: capacity null", q.deliveredBtuh, null)
check("no CFM: rise still 50", q.riseF, 50)

// --- Rise check ---------------------------------------------------------
check("rise 50 in 35–65 = ok", checkTemperatureRise(50, 35, 65).verdict, "ok")
check("rise 70 in 35–65 = high", checkTemperatureRise(70, 35, 65).verdict, "high")
check("rise 25 in 35–65 = low", checkTemperatureRise(25, 35, 65).verdict, "low")
check("no nameplate = unknown", checkTemperatureRise(50, null, null).verdict, "unknown")

// --- Clock the meter ----------------------------------------------------
near("clock: 1 ft³ @ 60 s NG = 61,800", inputBtuhFromClock(60, 1, GAS_HEATING_VALUE_BTU_PER_CUFT.natural_gas), 61800, 1)
near("clock: same dial on propane = 150,960", inputBtuhFromClock(60, 1, GAS_HEATING_VALUE_BTU_PER_CUFT.propane), 150960, 1)
check("clock: zero seconds = null", inputBtuhFromClock(0, 1, 1030), null)

const commissioning = {
  gas_type: "natural_gas",
  heating_value_btu_per_cuft: null,
  input_low_fire_btuh: 42000,
  input_high_fire_btuh: 60000,
  input_nameplate_btuh: 60000,
  afue_rated_pct: 80,
  condensing: false,
  rise_min_f: 35,
  rise_max_f: 65,
}
check("input for high fire = clocked 60k", inputBtuhForFire("high", commissioning).inputBtuh, 60000)
check("input for low fire = clocked 42k", inputBtuhForFire("low", commissioning).inputBtuh, 42000)
check("input source = clocked", inputBtuhForFire("low", commissioning).source, "clocked")
check("unknown fire falls to high", inputBtuhForFire("unknown", commissioning).inputBtuh, 60000)
const noClock = { ...commissioning, input_low_fire_btuh: null, input_high_fire_btuh: null }
check("no clock → nameplate", inputBtuhForFire("high", noClock).source, "nameplate")

// --- Live efficiency + grading ------------------------------------------
near("49,200 / 60,000 = 82 %", liveThermalEfficiencyPct(49200, 60000), 82, 0.01)
check("no input → null", liveThermalEfficiencyPct(49200, null), null)

const band80 = expectedSteadyStateBand(80, false)
check("80 % AFUE expects 80–84 steady", `${band80.low}-${band80.high}`, "80-84")
const band95 = expectedSteadyStateBand(95, true)
check("95 % condensing expects 94–98 steady", `${band95.low}-${band95.high}`, "94-98")

check("82 % on an 80 furnace = on_rating", gradeLiveEfficiency(82, 80, false).grade, "on_rating")
check("78 % on an 80 furnace = slightly_below", gradeLiveEfficiency(78, 80, false).grade, "slightly_below")
check("74 % on an 80 furnace = below", gradeLiveEfficiency(74, 80, false).grade, "below")
check("66 % on an 80 furnace = well_below", gradeLiveEfficiency(66, 80, false).grade, "well_below")
check("91 % on an 80 furnace = over_reading (radiant pickup)", gradeLiveEfficiency(91, 80, false).grade, "over_reading")
check("no AFUE = unknown", gradeLiveEfficiency(82, null, null).grade, "unknown")

// --- Seasonal -----------------------------------------------------------
near("seasonal 7.1M / 10M = 71 %", seasonalDeliveredEfficiencyPct(7_100_000, 10_000_000), 71, 0.01)
check("seasonal with no gas = null", seasonalDeliveredEfficiencyPct(100, 0), null)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
