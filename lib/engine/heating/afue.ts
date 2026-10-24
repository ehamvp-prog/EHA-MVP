// =====================================================================
// Gas-furnace efficiency — the heating twin of seer2.ts.
//
// Two different numbers, and they must never be confused:
//
//   LIVE THERMAL EFFICIENCY (steady state, right now)
//       = delivered BTU/hr ÷ gas input BTU/hr
//     The diagnostic. Catches underfiring, a fouled exchanger, restricted
//     airflow. On a healthy furnace it reads a couple of points ABOVE the
//     AFUE sticker (an 80 % furnace steady-states around 81–83 %) because
//     AFUE also charges the furnace for cycling and standby losses.
//
//   SEASONAL DELIVERED EFFICIENCY (whole season, every cycle counted)
//       = Σ delivered BTU ÷ Σ gas BTU
//     The one that is honestly comparable to the nameplate AFUE, and the
//     one that can say "rated 80, actually delivering 71". It needs the
//     cycle ledger (heat_cycles) and accrues all season.
//
// Gas input is NOT measured by a sensor on this stack. It is CLOCKED at
// commissioning: the installer times one revolution of the gas meter dial
// at low fire and again at high fire. That gives true BTU/hr per stage at
// the real manifold pressure, stored on system_profile. Runtime × stage
// input = gas used. One afternoon of labour replaces a permanent meter.
// =====================================================================

export type GasType = "natural_gas" | "propane"

// Heating value of the fuel, BTU per cubic foot. Natural gas varies by
// utility (Kansas Gas Service runs roughly 1,000–1,050); the commissioning
// form can override with the value printed on the gas bill.
export const GAS_HEATING_VALUE_BTU_PER_CUFT: Record<GasType, number> = {
  natural_gas: 1030,
  propane: 2516,
}

/**
 * Clock-the-meter → input BTU/hr.
 *   secondsPerRevolution : stopwatch time for one full turn of the test dial
 *   cuftPerRevolution    : the dial's size (½, 1, 2, 5 ft³ are common)
 */
export function inputBtuhFromClock(
  secondsPerRevolution: number,
  cuftPerRevolution: number,
  heatingValueBtuPerCuft: number,
): number | null {
  if (!(secondsPerRevolution > 0) || !(cuftPerRevolution > 0) || !(heatingValueBtuPerCuft > 0)) return null
  const cuftPerHour = (3600 / secondsPerRevolution) * cuftPerRevolution
  return cuftPerHour * heatingValueBtuPerCuft
}

export interface FurnaceCommissioning {
  gas_type: GasType | null
  heating_value_btu_per_cuft: number | null // optional override
  input_low_fire_btuh: number | null // clocked
  input_high_fire_btuh: number | null // clocked
  input_nameplate_btuh: number | null // sticker, fallback only
  afue_rated_pct: number | null
  condensing: boolean | null
  rise_min_f: number | null
  rise_max_f: number | null
}

export type FireStageForInput = "low" | "high" | "single" | "unknown"

/** Gas input for the current fire stage, clocked first, nameplate as fallback. */
export function inputBtuhForFire(
  fire: FireStageForInput,
  c: FurnaceCommissioning,
): { inputBtuh: number | null; source: "clocked" | "nameplate" | "none" } {
  const clockedHigh = c.input_high_fire_btuh
  const clockedLow = c.input_low_fire_btuh
  if (fire === "high" && clockedHigh != null) return { inputBtuh: clockedHigh, source: "clocked" }
  if (fire === "low" && clockedLow != null) return { inputBtuh: clockedLow, source: "clocked" }
  if ((fire === "single" || fire === "unknown") && (clockedHigh ?? clockedLow) != null) {
    return { inputBtuh: clockedHigh ?? clockedLow, source: "clocked" }
  }
  if (c.input_nameplate_btuh != null) return { inputBtuh: c.input_nameplate_btuh, source: "nameplate" }
  return { inputBtuh: null, source: "none" }
}

/** Live thermal efficiency, % — delivered over input, guarded. */
export function liveThermalEfficiencyPct(deliveredBtuh: number | null, inputBtuh: number | null): number | null {
  if (deliveredBtuh == null || inputBtuh == null || !(inputBtuh > 0) || !Number.isFinite(deliveredBtuh)) return null
  return (deliveredBtuh / inputBtuh) * 100
}

/**
 * What a HEALTHY furnace of this AFUE should read at steady state. The
 * sticker is a seasonal number; steady state runs a little above it.
 */
export function expectedSteadyStateBand(afuePct: number | null, condensing: boolean | null): { low: number; high: number } | null {
  if (afuePct == null || !Number.isFinite(afuePct)) return null
  const lift = condensing || afuePct >= 90 ? 1 : 2
  const center = afuePct + lift
  return { low: center - 2, high: center + 2 }
}

export type EfficiencyGrade =
  | "on_rating" // inside the expected steady-state band
  | "slightly_below" // 2–5 points under
  | "below" // 5–10 points under
  | "well_below" // >10 points under
  | "over_reading" // above anything physical → sensor placement / radiant pickup
  | "unknown"

export interface EfficiencyVerdict {
  grade: EfficiencyGrade
  measuredPct: number | null
  expected: { low: number; high: number } | null
  deltaPts: number | null // measured − expected center (negative = under)
  note: string
}

export function gradeLiveEfficiency(measuredPct: number | null, afuePct: number | null, condensing: boolean | null): EfficiencyVerdict {
  const expected = expectedSteadyStateBand(afuePct, condensing)
  if (measuredPct == null || expected == null) {
    return { grade: "unknown", measuredPct, expected, deltaPts: null, note: measuredPct == null ? "Efficiency can't be computed yet (need airflow, rise and a clocked input)." : "Enter the nameplate AFUE to grade this reading." }
  }
  const center = (expected.low + expected.high) / 2
  const delta = measuredPct - center
  const r = (s: number) => s.toFixed(0)

  // Nothing beats the fuel. A reading well above the expected band is the
  // supply probe seeing the heat exchanger (radiant), not better combustion.
  if (measuredPct > Math.min(expected.high + 4, 100)) {
    return { grade: "over_reading", measuredPct, expected, deltaPts: delta, note: `${r(measuredPct)} % is above what this furnace can physically do — the supply sensor is likely reading radiant heat from the exchanger. Move it further downstream, out of line of sight of the burners.` }
  }
  if (measuredPct >= expected.low) {
    return { grade: "on_rating", measuredPct, expected, deltaPts: delta, note: `${r(measuredPct)} % live — on rating for an ${r(afuePct as number)} % AFUE furnace (expect ${r(expected.low)}–${r(expected.high)} % steady state).` }
  }
  const under = expected.low - measuredPct
  if (under <= 3) return { grade: "slightly_below", measuredPct, expected, deltaPts: delta, note: `${r(measuredPct)} % live — a touch under the ${r(expected.low)}–${r(expected.high)} % expected for this furnace.` }
  if (under <= 8) return { grade: "below", measuredPct, expected, deltaPts: delta, note: `${r(measuredPct)} % live — clearly under the ${r(expected.low)}–${r(expected.high)} % expected. Check airflow (rise), burner input and the heat exchanger.` }
  return { grade: "well_below", measuredPct, expected, deltaPts: delta, note: `${r(measuredPct)} % live — well under the ${r(expected.low)}–${r(expected.high)} % expected for this furnace. Worth a service visit.` }
}

/** Seasonal delivered efficiency, % — the AFUE-comparable number. */
export function seasonalDeliveredEfficiencyPct(sumDeliveredBtu: number, sumInputBtu: number): number | null {
  if (!(sumInputBtu > 0) || !Number.isFinite(sumDeliveredBtu)) return null
  return (sumDeliveredBtu / sumInputBtu) * 100
}
