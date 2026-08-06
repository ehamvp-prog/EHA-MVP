// Verifies the constant-airflow ECM logic vs. the PSC generalized curve.
// Run: node scripts/verify-airflow.mjs
import { deriveAirflow } from "../lib/engine/airflow.ts"

let pass = 0
let fail = 0
function check(label, got, expect) {
  const ok = got === expect
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  -> ${got}${ok ? "" : `  (expected ${expect})`}`)
  ok ? pass++ : fail++
}
function near(label, got, expect, tol = 1) {
  const ok = got != null && Math.abs(got - expect) <= tol
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  -> ${got}${ok ? "" : `  (expected ~${expect})`}`)
  ok ? pass++ : fail++
}

const base = { tonnage: 2.5, cfmPerTon: 400, blowerType: "furnace", blowerModel: null, blowerSpeedTap: "high" }
// rated = 1000 CFM

// 1. ECM at DESIGN static, energized -> holds 1000 CFM, high confidence
let r = deriveAirflow({ ...base, ecmProfile: "400 CFM/ton", staticInWc: 0.5, blowerWatts: 300 })
near("ECM @0.5\" holds commanded CFM", r.cfm, 1000)
check("ECM @0.5\" confidence", r.confidence, "ecm_commanded")
check("ECM @0.5\" not generalized", r.generalizedModel, false)

// 2. ECM at HIGH static (1.0") -> STILL holds 1000 CFM (not halved), flags limit
r = deriveAirflow({ ...base, ecmProfile: "400 CFM/ton", staticInWc: 1.0, blowerWatts: 430 })
near("ECM @1.0\" STILL holds commanded CFM (not halved)", r.cfm, 1000)
check("ECM @1.0\" confidence still commanded", r.confidence, "ecm_commanded")
check("ECM @1.0\" flags over-limit in note", /exceeds the typical ECM limit/.test(r.note), true)

// 3. ECM with low blower watts -> hold commanded but lower confidence
r = deriveAirflow({ ...base, ecmProfile: "400 CFM/ton", staticInWc: 0.6, blowerWatts: 10 })
near("ECM low-watts holds commanded CFM", r.cfm, 1000)
check("ECM low-watts confidence downgraded", r.confidence, "static_derived")

// 4. ECM with no blower watts reading -> hold commanded, high confidence (can't disprove)
r = deriveAirflow({ ...base, ecmProfile: "400 CFM/ton", staticInWc: 0.6, blowerWatts: null })
near("ECM no-watts holds commanded CFM", r.cfm, 1000)
check("ECM no-watts confidence", r.confidence, "ecm_commanded")

// 5. PSC (no ecm_profile) at high static -> generalized curve DOES cut CFM (unchanged)
r = deriveAirflow({ ...base, ecmProfile: null, staticInWc: 1.0, blowerWatts: 430 })
check("PSC @1.0\" uses generalized curve", r.generalizedModel, true)
check("PSC @1.0\" confidence", r.confidence, "static_derived")
const pscCut = r.cfm < 700
check("PSC @1.0\" CFM is cut below 700 (fan-law)", pscCut, true)

// 6. No tonnage -> fallback regardless of ECM
r = deriveAirflow({ ...base, tonnage: null, ecmProfile: "400 CFM/ton", staticInWc: 0.6, blowerWatts: 300 })
check("No tonnage -> fallback", r.confidence, "fallback")

// 7. Constant-TORQUE ECM (this site: Goodman GM9S tap 5, rated 2.5*336 = 840).
//    Airflow must VARY with static and match the derived static curve that
//    backfilled the historical readings (verified diff=0 against the DB).
const ct = { tonnage: 2.5, cfmPerTon: 336, blowerType: "furnace", blowerModel: "Gm9s800603bnaa", blowerSpeedTap: "5", ecmProfile: "constant_torque_9speed_tap5_derived_20260805" }
r = deriveAirflow({ ...ct, staticInWc: 0.7, blowerWatts: 300 })
near("CT @0.70\" -> 840 (anchor)", r.cfm, 840, 0)
check("CT confidence is derived_static_curve_v1", r.confidence, "derived_static_curve_v1")
check("CT is a generalized (non-OEM) model", r.generalizedModel, true)
near("CT @0.67312\" -> 848 (matches DB)", deriveAirflow({ ...ct, staticInWc: 0.67312 }).cfm, 848, 0)
near("CT @0.70918\" -> 837 (matches DB)", deriveAirflow({ ...ct, staticInWc: 0.70918 }).cfm, 837, 0)
near("CT @0.7212\" -> 834 (matches DB)", deriveAirflow({ ...ct, staticInWc: 0.7212 }).cfm, 834, 0)
near("CT @0.16828\" (low static) -> 996 (matches DB)", deriveAirflow({ ...ct, staticInWc: 0.16828 }).cfm, 996, 0)
near("CT clamps to 1000 at near-zero static", deriveAirflow({ ...ct, staticInWc: 0.0 }).cfm, 1000, 0)
near("CT clamps to 600 at very high static", deriveAirflow({ ...ct, staticInWc: 2.0 }).cfm, 600, 0)
// Airflow must NOT be held flat the way a constant-airflow ECM would be.
check("CT airflow varies with static (not flat)", deriveAirflow({ ...ct, staticInWc: 0.3 }).cfm !== deriveAirflow({ ...ct, staticInWc: 0.9 }).cfm, true)
// No static reading -> fallback (cannot place the point on the curve).
check("CT with no static -> fallback", deriveAirflow({ ...ct, staticInWc: null }).confidence, "fallback")

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
