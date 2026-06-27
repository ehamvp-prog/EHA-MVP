// =====================================================================
// Psychrometrics — moist air properties from dry bulb, RH, and pressure.
// All math in IP (inch-pound) units to match field instruments.
//
// Inputs:
//   tempF  : dry bulb temperature, deg F
//   rhPct  : relative humidity, 0-100
//   pInHg  : barometric (absolute) pressure, inches of mercury
//
// Outputs per pound of DRY AIR (this is critical for unit consistency):
//   humidityRatio W : lb water / lb dry air
//   enthalpy h      : BTU / lb dry air
//   specificVolume v: ft^3 / lb dry air
// =====================================================================

// Unit conversions
const INHG_TO_PSIA = 0.4911541 // 1 inHg = 0.4911541 psia

export interface MoistAirState {
  tempF: number
  rhPct: number
  pInHg: number
  satVaporPressurePsia: number
  vaporPressurePsia: number
  humidityRatio: number // W, lb water / lb dry air
  enthalpy: number // h, BTU / lb dry air
  specificVolume: number // v, ft^3 / lb dry air
}

/**
 * Saturation vapor pressure over liquid water, in psia.
 * Uses the Magnus-Tetens form (good to well within field accuracy from
 * roughly 30-120 F). Temperature converted F -> C internally.
 */
export function saturationVaporPressurePsia(tempF: number): number {
  const tC = (tempF - 32) * (5 / 9)
  // Magnus formula -> saturation pressure in kPa
  const pKpa = 0.61094 * Math.exp((17.625 * tC) / (tC + 243.04))
  // kPa -> psia (1 kPa = 0.1450377 psia)
  return pKpa * 0.1450377
}

/**
 * Full moist-air state from dry bulb, RH, and barometric pressure.
 * Returns null if inputs are missing or non-physical.
 */
export function moistAirState(
  tempF: number | null | undefined,
  rhPct: number | null | undefined,
  pInHg: number | null | undefined,
): MoistAirState | null {
  if (
    tempF == null ||
    rhPct == null ||
    pInHg == null ||
    !Number.isFinite(tempF) ||
    !Number.isFinite(rhPct) ||
    !Number.isFinite(pInHg) ||
    pInHg <= 0 ||
    rhPct < 0 ||
    rhPct > 100
  ) {
    return null
  }

  const pPsia = pInHg * INHG_TO_PSIA
  const pws = saturationVaporPressurePsia(tempF)
  const pw = (rhPct / 100) * pws

  // Guard: vapor pressure can't meet/exceed total pressure
  if (pw >= pPsia) return null

  // Humidity ratio, lb water / lb dry air (ASHRAE)
  const W = 0.621945 * (pw / (pPsia - pw))

  // Enthalpy per lb dry air, BTU/lb (spec formula): h = 0.24T + W(1061 + 0.444T)
  const h = 0.24 * tempF + W * (1061 + 0.444 * tempF)

  // Specific volume, ft^3 / lb dry air (ASHRAE IP):
  // v = 0.370486 * (T+459.67) * (1 + 1.607858 W) / P_psia
  const v = (0.370486 * (tempF + 459.67) * (1 + 1.607858 * W)) / pPsia

  return {
    tempF,
    rhPct,
    pInHg,
    satVaporPressurePsia: pws,
    vaporPressurePsia: pw,
    humidityRatio: W,
    enthalpy: h,
    specificVolume: v,
  }
}
