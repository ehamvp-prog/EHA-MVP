// Verifies the efficiency engine: an independent hand-calc of the cooling
// psychrometrics, then end-to-end runEngine cases for mode gating.
// Run: node scripts/verify-engine.mjs
import "./_ts-resolve.mjs"

const { runEngine } = await import("../lib/engine/index.ts")
const { DEFAULT_FURNACE_SIGNATURE } = await import("../lib/engine/heating/furnace-sequence.ts")

let pass = 0
let fail = 0
function check(name, ok, detail = "") {
  if (ok) pass++
  else fail++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  →  ${detail}` : ""}`)
}
const near = (got, want, pct) =>
  typeof got === "number" && Math.abs(got - want) <= Math.abs(want) * pct

// --- Hand-calc cross-check (formulas re-implemented inline) -------------
const INHG_TO_PSIA = 0.4911541
function pws(tF) {
  const tC = (tF - 32) * (5 / 9)
  return 0.61094 * Math.exp((17.625 * tC) / (tC + 243.04)) * 0.1450377
}
function state(tF, rh, pInHg) {
  const pPsia = pInHg * INHG_TO_PSIA
  const pw = (rh / 100) * pws(tF)
  const W = 0.621945 * (pw / (pPsia - pw))
  return {
    h: 0.24 * tF + W * (1061 + 0.444 * tF),
    v: (0.370486 * (tF + 459.67) * (1 + 1.607858 * W)) / pPsia,
  }
}
const ret = state(75.8, 51.3, 29.92)
const sup = state(55.4, 92.1, 29.92)
const Q = ((1200 * 60) / ret.v) * (ret.h - sup.h)
check("hand-calc return enthalpy ≈ 28.8", near(ret.h, 28.8, 0.02), ret.h.toFixed(3))
check("hand-calc return spec vol ≈ 13.7", near(ret.v, 13.7, 0.02), ret.v.toFixed(3))
check("hand-calc capacity ≈ 32,700", near(Q, 32700, 0.05), Q.toFixed(0))

// --- runEngine fixtures --------------------------------------------------
const PROFILE = {
  system_tonnage: 2,
  cfm_per_ton: 420,
  blower_type: "psc",
  rated_seer2: 13.4,
  seer2_conversion_factor: 0.95,
  gas_type: "natural_gas",
  gas_rate_per_therm: 1.2,
  furnace_input_low_fire_btuh: 46000,
  furnace_input_high_fire_btuh: 70000,
  furnace_input_nameplate_btuh: 70000,
  furnace_afue_rated_pct: 80,
  furnace_condensing: false,
  furnace_rise_min_f: 35,
  furnace_rise_max_f: 65,
  heat_cfm: 840,
}

function devices({ condW, furnaceW, supplyF, supplyRh, returnF, returnRh, staticInWc = 0.5 }) {
  const t = new Date().toISOString()
  const d = (device_id, payload) => ({ device_id, device_type: null, payload, recorded_at: t, received_at: t })
  return [
    d("condenser", { condenser_total_watts: condW }),
    d("ahu", { blower_watts: furnaceW }),
    d("supply", { supply_temp_f: supplyF, supply_rh: supplyRh }),
    d("dht22_static", { return_temp_f: returnF, return_rh: returnRh, static_pressure_inwc: staticInWc }),
  ]
}
const OPTS = { liveBarometricInHg: 29.92, outdoorTempF: 40 }

// (a) Furnace burning — heating math runs, cooling math is gated off.
{
  const r = runEngine(
    devices({ condW: 0, furnaceW: 260, supplyF: 128, supplyRh: 10, returnF: 68, returnRh: 40 }),
    PROFILE,
    { ...OPTS, prevFurnaceStage: "burn", prevSeasonMode: "heating" },
  )
  check("(a) operating_mode = heating", r.operating_mode === "heating", r.operating_mode)
  check("(a) capacity_btuh = null", r.capacity_btuh === null, String(r.capacity_btuh))
  check("(a) live_eer = null", r.live_eer === null, String(r.live_eer))
  check("(a) measured_seer2 = null", r.measured_seer2_estimate === null, String(r.measured_seer2_estimate))
  check("(a) delivered_btuh ≈ 54,000 ±3%", near(r.delivered_btuh, 54000, 0.03), String(r.delivered_btuh))
  check("(a) temp_rise_f = 60", r.temp_rise_f === 60, String(r.temp_rise_f))
  check("(a) gas_cost_per_hour > 0", typeof r.gas_cost_per_hour === "number" && r.gas_cost_per_hour > 0, String(r.gas_cost_per_hour))
}

// (b) Compressor running — unchanged cooling behavior.
{
  const r = runEngine(
    devices({ condW: 1900, furnaceW: 248, supplyF: 55, supplyRh: 92, returnF: 75, returnRh: 50 }),
    PROFILE,
    { ...OPTS, outdoorTempF: 90, prevFurnaceStage: "cooling_blower", prevSeasonMode: "cooling" },
  )
  check("(b) operating_mode = cooling", r.operating_mode === "cooling", r.operating_mode)
  check("(b) live_eer populated", typeof r.live_eer === "number" && r.live_eer > 0, String(r.live_eer))
  check("(b) capacity_btuh populated", typeof r.capacity_btuh === "number" && r.capacity_btuh > 0, String(r.capacity_btuh))
  check("(b) delivered_btuh = null", r.delivered_btuh === null, String(r.delivered_btuh))
  check("(b) gas_input_btuh = null", r.gas_input_btuh === null, String(r.gas_input_btuh))
}

// (c) Prepurge — inducer only, blower off. Must not read as fan-only.
// Uses this site's measured bands (fan 77 W, inducer 95 W). The generic
// default (fan 80 W ±16) would put 96 W in the fan band — commission first.
{
  const r = runEngine(
    devices({ condW: 0, furnaceW: 96, supplyF: 68, supplyRh: 40, returnF: 68, returnRh: 40 }),
    PROFILE,
    {
      ...OPTS,
      prevFurnaceStage: "idle",
      prevSeasonMode: "heating",
      furnaceSignature: {
        ...DEFAULT_FURNACE_SIGNATURE,
        fan_only_w: 77,
        inducer_only_w: 95,
        burn_low_w: 260,
        burn_high_w: 320,
        burn_single_w: null,
        cooling_blower_w: 248,
        commissioned: true,
      },
    },
  )
  check("(c) furnace_stage = prepurge", r.furnace_stage === "prepurge", r.furnace_stage)
  check("(c) system_state ≠ fan_only", r.system_state !== "fan_only", r.system_state)
  check("(c) airflow_cfm = null", r.airflow_cfm === null, String(r.airflow_cfm))
}

// (d) Cooling coast — cooling-tap blower after the compressor stops.
{
  const r = runEngine(
    devices({ condW: 0, furnaceW: 250, supplyF: 69, supplyRh: 80, returnF: 75, returnRh: 50 }),
    PROFILE,
    { ...OPTS, outdoorTempF: 85, prevFurnaceStage: "cooling_blower", prevSeasonMode: "cooling" },
  )
  check("(d) furnace_stage = cooling_blower", r.furnace_stage === "cooling_blower", r.furnace_stage)
  check("(d) not a burn", !String(r.furnace_stage).startsWith("burn"), r.furnace_stage)
  check("(d) gas_input_btuh = null", r.gas_input_btuh === null, String(r.gas_input_btuh))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
