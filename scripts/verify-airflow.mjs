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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
