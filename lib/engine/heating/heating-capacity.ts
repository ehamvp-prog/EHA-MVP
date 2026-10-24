// =====================================================================
// Delivered heat from the air side — the furnace twin of capacity.ts.
//
// A gas furnace adds NO moisture to the air, so there is no latent term.
// Delivered heat is pure sensible heat:
//
//   Q (BTU/hr) = m_da (lb_da/hr) * c_p,moist (BTU/lb_da·°F) * rise (°F)
//
//   m_da      = CFM * 60 / v_return            (dry-air mass flow, same
//                                               convention as capacity.ts)
//   c_p,moist = 0.240 + 0.444 * W               (dry air + water vapour it
//                                               carries; W from the RETURN
//                                               state — it does not change
//                                               across a heat exchanger)
//   rise      = supply_temp − return_temp
//
// The familiar field shortcut Q = 1.08 * CFM * rise is this same equation
// with standard air (v = 13.33 ft³/lb, W ≈ 0.01) baked in. We keep the
// psychrometric form so Wichita's pressure and the live return humidity
// are honoured, exactly as the cooling side already does.
// =====================================================================

import type { MoistAirState } from "../psychrometrics"

export interface HeatingCapacityResult {
  deliveredBtuh: number | null
  riseF: number | null
  dryAirMassFlowLbHr: number | null
  cpMoist: number | null
}

const CP_DRY_AIR = 0.24 // BTU / lb·°F
const CP_WATER_VAPOUR = 0.444 // BTU / lb·°F

export function heatingCapacityFromAirSide(
  cfm: number | null,
  returnState: MoistAirState | null,
  supplyTempF: number | null,
): HeatingCapacityResult {
  if (returnState == null || supplyTempF == null || !Number.isFinite(supplyTempF)) {
    return { deliveredBtuh: null, riseF: null, dryAirMassFlowLbHr: null, cpMoist: null }
  }
  const riseF = supplyTempF - returnState.tempF

  if (cfm == null || !Number.isFinite(cfm) || cfm <= 0) {
    // We can still report the rise — it is a diagnostic on its own.
    return { deliveredBtuh: null, riseF, dryAirMassFlowLbHr: null, cpMoist: null }
  }

  const mDa = (cfm * 60) / returnState.specificVolume
  const cp = CP_DRY_AIR + CP_WATER_VAPOUR * returnState.humidityRatio
  const q = mDa * cp * riseF

  return { deliveredBtuh: q, riseF, dryAirMassFlowLbHr: mDa, cpMoist: cp }
}

// ---------------------------------------------------------------------
// Temperature-rise check against the nameplate range.
// Every furnace nameplate states an allowed rise (e.g. "RISE 35–65°F").
//   below range → too much airflow for the input (or burner underfiring)
//   above range → not enough airflow: filter, duct, blower tap, closed
//                 registers. This is what trips limit switches and
//                 short-cycles the furnace — the #1 reason a furnace
//                 underperforms its rating.
// ---------------------------------------------------------------------

export type RiseVerdict = "low" | "ok" | "high" | "unknown"

export interface RiseCheck {
  verdict: RiseVerdict
  riseF: number | null
  minF: number | null
  maxF: number | null
  note: string
}

export function checkTemperatureRise(
  riseF: number | null,
  nameplateMinF: number | null | undefined,
  nameplateMaxF: number | null | undefined,
): RiseCheck {
  const minF = nameplateMinF ?? null
  const maxF = nameplateMaxF ?? null
  if (riseF == null || !Number.isFinite(riseF)) {
    return { verdict: "unknown", riseF: null, minF, maxF, note: "No supply/return readings for a rise." }
  }
  if (minF == null || maxF == null) {
    return { verdict: "unknown", riseF, minF, maxF, note: `Rise ${riseF.toFixed(0)}°F — enter the nameplate rise range to judge it.` }
  }
  if (riseF < minF) {
    return { verdict: "low", riseF, minF, maxF, note: `Rise ${riseF.toFixed(0)}°F is below the ${minF}–${maxF}°F nameplate range — airflow is high for this input, or the burner is underfiring.` }
  }
  if (riseF > maxF) {
    return { verdict: "high", riseF, minF, maxF, note: `Rise ${riseF.toFixed(0)}°F is above the ${minF}–${maxF}°F nameplate range — not enough airflow. Check the filter, blower tap and ductwork; this is what trips the high limit.` }
  }
  return { verdict: "ok", riseF, minF, maxF, note: `Rise ${riseF.toFixed(0)}°F is inside the ${minF}–${maxF}°F nameplate range.` }
}
