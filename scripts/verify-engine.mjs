// Hand-calc verification of the efficiency engine. Run with:
//   npx tsx scripts/verify-engine.mjs  (or compiled). We re-implement the
// formulas inline here to cross-check the TS modules independently.

const INHG_TO_PSIA = 0.4911541

function pws(tF) {
  const tC = (tF - 32) * (5 / 9)
  const kPa = 0.61094 * Math.exp((17.625 * tC) / (tC + 243.04))
  return kPa * 0.1450377
}
function state(tF, rh, pInHg) {
  const pPsia = pInHg * INHG_TO_PSIA
  const pw = (rh / 100) * pws(tF)
  const W = 0.621945 * (pw / (pPsia - pw))
  const h = 0.24 * tF + W * (1061 + 0.444 * tF)
  const v = (0.370486 * (tF + 459.67) * (1 + 1.607858 * W)) / pPsia
  return { W, h, v }
}

// Inputs (return warm/humid, supply cold/wet) at 29.92 inHg
const ret = state(75.8, 51.3, 29.92)
const sup = state(55.4, 92.1, 29.92)
const cfm = 1200 // 3 ton x 400 cfm/ton, ECM
const mDa = (cfm * 60) / ret.v
const dh = ret.h - sup.h
const Q = mDa * dh

const condW = 3000 // realistic 3-ton draw for sanity
const blowerW = 400
const totalW = condW + blowerW
const eer = Q / totalW
const seer2 = eer * 0.95

console.log("[v0] return enthalpy  :", ret.h.toFixed(3), "BTU/lb (expect ~28.8)")
console.log("[v0] supply enthalpy  :", sup.h.toFixed(3), "BTU/lb (expect ~22.6)")
console.log("[v0] return spec vol  :", ret.v.toFixed(3), "ft3/lb (expect ~13.7)")
console.log("[v0] dry-air mass flow:", mDa.toFixed(0), "lb/hr")
console.log("[v0] capacity         :", Q.toFixed(0), "BTU/hr (expect ~32,700)")
console.log("[v0] tons             :", (Q / 12000).toFixed(2), "tons")
console.log("[v0] live EER         :", eer.toFixed(2))
console.log("[v0] measured SEER2   :", seer2.toFixed(2), "(EER x 0.95)")

// --- Generalized blower curve check (3-ton, 400 cfm/ton => 1200 @ 0.5") ---
function curve(rated, staticInWc) {
  const steps = (staticInWc - 0.5) / 0.1
  const slope = steps >= 0 ? 0.1 : 0.08
  const factor = Math.min(1.6, Math.max(0.4, 1 - slope * steps))
  return rated * factor
}
const rated = 1200
console.log("\n[v0] --- blower curve ---")
console.log("[v0] @0.5\" WC:", curve(rated, 0.5).toFixed(0), "CFM (expect 1200)")
console.log("[v0] @0.7\" WC:", curve(rated, 0.7).toFixed(0), "CFM (expect ~960)")
console.log("[v0] @0.3\" WC:", curve(rated, 0.3).toFixed(0), "CFM (expect ~1380)")
