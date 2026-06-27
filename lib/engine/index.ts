// =====================================================================
// Efficiency Engine orchestrator. Combines:
//   profile inputs + latest sensor readings
//     -> psychrometrics -> airflow -> capacity -> power -> EER -> SEER2
//
// Produces one computed result shaped to the computed_readings table.
// Partial rows are fine: any field we cannot compute stays null.
// =====================================================================

import { moistAirState } from "./psychrometrics"
import { deriveAirflow, type AirflowConfidence } from "./airflow"
import { capacityFromAirSide } from "./capacity"
import { computeEfficiency } from "./seer2"
import { extractHvacInputs, type LatestDevice } from "./extract"

export interface SystemProfileInputs {
  system_tonnage?: number | null
  cfm_per_ton?: number | null
  barometric_pressure_inhg?: number | null
  blower_type?: string | null
  ecm_profile?: string | null
  blower_speed_tap?: string | null
  equipment_class?: string | null
  seer2_conversion_factor?: number | null
  rated_seer2?: number | null
}

export interface ComputedReading {
  reading_at: string

  // Raw HVAC inputs (traceability)
  return_temp_f: number | null
  return_rh: number | null
  supply_temp_f: number | null
  supply_rh: number | null
  static_pressure_inwc: number | null
  condenser_watts_leg1: number | null
  condenser_watts_leg2: number | null
  blower_watts: number | null

  // Computed efficiency
  airflow_cfm: number | null
  airflow_confidence: AirflowConfidence
  return_enthalpy: number | null
  supply_enthalpy: number | null
  capacity_btuh: number | null
  total_watts: number | null
  live_eer: number | null
  measured_seer2_estimate: number | null

  // Engine diagnostics (not persisted unless desired)
  diagnostics: {
    ratedCfm: number | null
    staticFlag: string
    airflowNote: string
    seer2FactorUsed: number
    seer2FactorSource: string
    ratedSeer2: number | null
    matched: ReturnType<typeof extractHvacInputs>["matched"]
  }
}

export function runEngine(
  devices: LatestDevice[],
  profile: SystemProfileInputs | null,
  readingAt: string = new Date().toISOString(),
): ComputedReading {
  const inputs = extractHvacInputs(devices)

  // Barometric pressure: required for psychrometrics. Profile anchor only
  // (no pressure sensor in the air stream).
  const pInHg = profile?.barometric_pressure_inhg ?? null

  const returnState = moistAirState(inputs.returnTempF, inputs.returnRh, pInHg)
  const supplyState = moistAirState(inputs.supplyTempF, inputs.supplyRh, pInHg)

  const airflow = deriveAirflow({
    staticInWc: inputs.staticInWc,
    tonnage: profile?.system_tonnage,
    cfmPerTon: profile?.cfm_per_ton,
    blowerType: profile?.blower_type,
    ecmProfile: profile?.ecm_profile,
    blowerSpeedTap: profile?.blower_speed_tap,
  })

  const capacity = capacityFromAirSide(airflow.cfm, returnState, supplyState)

  const eff = computeEfficiency(
    capacity.capacityBtuh,
    inputs.totalWatts,
    profile?.equipment_class,
    profile?.seer2_conversion_factor,
  )

  return {
    reading_at: readingAt,
    return_temp_f: inputs.returnTempF,
    return_rh: inputs.returnRh,
    supply_temp_f: inputs.supplyTempF,
    supply_rh: inputs.supplyRh,
    static_pressure_inwc: inputs.staticInWc,
    condenser_watts_leg1: inputs.condenserWattsLeg1,
    condenser_watts_leg2: inputs.condenserWattsLeg2,
    blower_watts: inputs.blowerWatts,

    airflow_cfm: airflow.cfm,
    airflow_confidence: airflow.confidence,
    return_enthalpy: returnState?.enthalpy ?? null,
    supply_enthalpy: supplyState?.enthalpy ?? null,
    capacity_btuh: capacity.capacityBtuh,
    total_watts: eff.totalWatts,
    live_eer: eff.liveEer,
    measured_seer2_estimate: eff.measuredSeer2Estimate,

    diagnostics: {
      ratedCfm: airflow.ratedCfm,
      staticFlag: airflow.staticFlag,
      airflowNote: airflow.note,
      seer2FactorUsed: eff.seer2FactorUsed,
      seer2FactorSource: eff.seer2FactorSource,
      ratedSeer2: profile?.rated_seer2 ?? null,
      matched: inputs.matched,
    },
  }
}
