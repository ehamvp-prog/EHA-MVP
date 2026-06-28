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
import { deriveCoilState, type CoilState } from "./coil-state"
import { deriveSystemState, type SystemRunState, type SensorFault } from "./system-state"
import { computeCost, type TouPeriod, type Season } from "./cost"
import {
  assessAnomaly,
  type EfficiencyColor,
  type BaselineSample,
  type WeatherConfidence,
} from "./anomaly"

export interface SystemProfileInputs {
  system_tonnage?: number | null
  cfm_per_ton?: number | null
  blower_type?: string | null
  blower_model?: string | null
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

  // Derived live state (never set by hand)
  coil_state: CoilState

  // Corroborated run-state + sensor fault flags
  system_running: boolean
  system_state: SystemRunState
  cooling_delta_f: number | null
  sensor_faults: SensorFault[]

  // Live Evergy RTOU cost (tariff energy only; riders excluded)
  tou_season: Season
  tou_period: TouPeriod
  rate_per_kwh: number
  cost_per_hour: number | null

  // Pressure actually used for psychrometrics (live, internal)
  barometric_pressure_inhg: number | null

  // Outdoor conditions used for anomaly conditioning (internal, live)
  outdoor_temp_f: number | null
  weather_confidence: WeatherConfidence

  // Anomaly Color Layer verdict
  efficiency_color: EfficiencyColor

  // Engine diagnostics (not persisted unless desired)
  diagnostics: {
    ratedCfm: number | null
    staticFlag: string
    generalizedModel: boolean
    airflowNote: string
    seer2FactorUsed: number
    seer2FactorSource: string
    ratedSeer2: number | null
    coilStateNote: string
    systemStateNote: string
    systemBasis: string[]
    pressureSource: string
    anomalyNote: string
    anomalyDeviationPct: number | null
    anomalyBaselineEer: number | null
    anomalyBaselineSamples: number
    anomalyCapped: boolean
    matched: ReturnType<typeof extractHvacInputs>["matched"]
  }
}

export interface EngineOptions {
  // Live barometric pressure (inHg) from the outdoor weather lookup. This is
  // derived internally — never typed in by an installer.
  liveBarometricInHg?: number | null
  // Live outdoor conditions (internal) used for anomaly conditioning.
  outdoorTempF?: number | null
  weatherConfidence?: WeatherConfidence
  // Rolling history (already temp-paired) for the healthy baseline.
  baselineSamples?: BaselineSample[]
  readingAt?: string
}

export function runEngine(
  devices: LatestDevice[],
  profile: SystemProfileInputs | null,
  options: EngineOptions = {},
): ComputedReading {
  const readingAt = options.readingAt ?? new Date().toISOString()
  const inputs = extractHvacInputs(devices)

  // Barometric pressure: required for psychrometrics. Comes from the live
  // outdoor observation (internal). Falls back to the standard sea-level
  // value so the math can still run if weather is briefly unavailable.
  const liveP = options.liveBarometricInHg ?? null
  const pInHg = liveP ?? 29.92
  const pressureSource = liveP != null ? "live_observation" : "standard_fallback"

  const returnState = moistAirState(inputs.returnTempF, inputs.returnRh, pInHg)
  const supplyState = moistAirState(inputs.supplyTempF, inputs.supplyRh, pInHg)

  const coil = deriveCoilState({
    condenserWattsLeg1: inputs.condenserWattsLeg1,
    condenserWattsLeg2: inputs.condenserWattsLeg2,
    returnRh: inputs.returnRh,
    supplyRh: inputs.supplyRh,
  })

  // Corroborated run-state: condenser power OR blower energized OR a real
  // temperature drop. Also surfaces sensor-fault flags on disagreement.
  const systemState = deriveSystemState({
    condenserTotalWatts: inputs.condenserTotalWatts,
    blowerWatts: inputs.blowerWatts,
    returnTempF: inputs.returnTempF,
    supplyTempF: inputs.supplyTempF,
    staticInWc: inputs.staticInWc,
  })

  const airflow = deriveAirflow({
    staticInWc: inputs.staticInWc,
    tonnage: profile?.system_tonnage,
    cfmPerTon: profile?.cfm_per_ton,
    blowerType: profile?.blower_type,
    blowerModel: profile?.blower_model,
    ecmProfile: profile?.ecm_profile,
    blowerSpeedTap: profile?.blower_speed_tap,
    blowerWatts: inputs.blowerWatts,
  })

  const capacity = capacityFromAirSide(airflow.cfm, returnState, supplyState)

  const eff = computeEfficiency(
    capacity.capacityBtuh,
    inputs.totalWatts,
    profile?.equipment_class,
    profile?.seer2_conversion_factor,
  )

  // Live electricity cost rate from the Evergy RTOU tariff, based on the
  // reading's CST timestamp and the current total power draw.
  const cost = computeCost(eff.totalWatts, readingAt)

  // Anomaly Color Layer: compare live EER to the temp-conditioned healthy
  // baseline, weighted by how trustworthy the outdoor data is.
  const outdoorTempF = options.outdoorTempF ?? null
  const weatherConfidence = options.weatherConfidence ?? null
  const anomaly = assessAnomaly({
    liveEer: eff.liveEer,
    totalWatts: eff.totalWatts,
    systemRunning: systemState.running,
    outdoorTempF,
    weatherConfidence,
    baseline: options.baselineSamples ?? [],
  })

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

    coil_state: coil.state,

    system_running: systemState.running,
    system_state: systemState.state,
    cooling_delta_f: systemState.coolingDeltaF,
    sensor_faults: systemState.faults,

    tou_season: cost.season,
    tou_period: cost.tou_period,
    rate_per_kwh: cost.rate_per_kwh,
    cost_per_hour: cost.cost_per_hour,

    barometric_pressure_inhg: liveP,

    outdoor_temp_f: outdoorTempF,
    weather_confidence: weatherConfidence,

    efficiency_color: anomaly.color,

    diagnostics: {
      ratedCfm: airflow.ratedCfm,
      staticFlag: airflow.staticFlag,
      generalizedModel: airflow.generalizedModel,
      airflowNote: airflow.note,
      seer2FactorUsed: eff.seer2FactorUsed,
      seer2FactorSource: eff.seer2FactorSource,
      ratedSeer2: profile?.rated_seer2 ?? null,
      coilStateNote: coil.note,
      systemStateNote: systemState.note,
      systemBasis: systemState.basis,
      pressureSource,
      anomalyNote: anomaly.note,
      anomalyDeviationPct: anomaly.deviationPct,
      anomalyBaselineEer: anomaly.baselineEer,
      anomalyBaselineSamples: anomaly.baselineSampleCount,
      anomalyCapped: anomaly.capped,
      matched: inputs.matched,
    },
  }
}
