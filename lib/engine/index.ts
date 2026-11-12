// =====================================================================
// Efficiency Engine orchestrator. Combines:
//   profile inputs + latest sensor readings
//     -> furnace sequence decode -> live operating mode
//     -> COOLING: psychrometrics -> airflow -> capacity -> power -> EER -> SEER2
//     -> HEATING: airflow (heat tap) -> delivered BTU/h -> gas input -> thermal eff
//
// Produces one computed result shaped to the computed_readings table.
// Partial rows are fine: any field we cannot compute stays null.
// =====================================================================

import { moistAirState } from "./psychrometrics"
import { deriveAirflow, type AirflowConfidence, type AirflowResult } from "./airflow"
import { capacityFromAirSide } from "./capacity"
import { computeEfficiency } from "./seer2"
import { extractHvacInputs, type LatestDevice } from "./extract"
import { deriveCoilState, type CoilState } from "./coil-state"
import { deriveSystemState, type SystemRunState, type SensorFault, type HvacStatus } from "./system-state"
import { computeCost, type TouPeriod, type Season } from "./cost"
import {
  assessAnomaly,
  type EfficiencyColor,
  type BaselineSample,
  type WeatherConfidence,
} from "./anomaly"
import {
  decodeFurnaceStep,
  DEFAULT_FURNACE_SIGNATURE,
  type FurnaceSignature,
  type FurnaceStage,
  type FireStage,
  type FurnaceStepResult,
} from "./heating/furnace-sequence"
import { heatingCapacityFromAirSide, checkTemperatureRise, type RiseVerdict } from "./heating/heating-capacity"
import {
  inputBtuhForFire,
  liveThermalEfficiencyPct,
  gradeLiveEfficiency,
  type FurnaceCommissioning,
  type GasType,
  type EfficiencyGrade,
} from "./heating/afue"
import {
  deriveOperatingMode,
  type LiveMode,
  type SeasonMode,
  type ModeSource,
  type ModeDisagreement,
  type ThermostatMode,
  type ThermostatStatus,
} from "./heating/operating-mode"

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

  // Furnace commissioning
  gas_type?: string | null
  gas_rate_per_therm?: number | null
  gas_heating_value_btu_per_cuft?: number | null
  furnace_input_low_fire_btuh?: number | null
  furnace_input_high_fire_btuh?: number | null
  furnace_input_nameplate_btuh?: number | null
  furnace_afue_rated_pct?: number | null
  furnace_condensing?: boolean | null
  furnace_rise_min_f?: number | null
  furnace_rise_max_f?: number | null
  heat_cfm?: number | null
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

  // Computed efficiency (cooling only — null in any other mode)
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

  // Operating mode + furnace sequence
  operating_mode: LiveMode
  season_mode: SeasonMode
  mode_source: ModeSource
  furnace_stage: FurnaceStage
  fire_stage: FireStage | null
  mode_disagreements: ModeDisagreement[]

  // Heating math (heating only — null otherwise)
  temp_rise_f: number | null
  delivered_btuh: number | null
  gas_input_btuh: number | null
  live_thermal_eff_pct: number | null
  rise_verdict: RiseVerdict | null

  // Live Evergy RTOU cost (tariff energy only; riders excluded)
  tou_season: Season
  tou_period: TouPeriod
  rate_per_kwh: number
  cost_per_hour: number | null
  // Gas burn cost while the burner is on (0 when not burning, null if unknown)
  gas_cost_per_hour: number | null

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
    systemOffCycle: boolean
    systemBasis: string[]
    pressureSource: string
    anomalyNote: string
    anomalyDeviationPct: number | null
    anomalyBaselineEer: number | null
    anomalyBaselineSamples: number
    anomalyCapped: boolean
    furnaceNote: string
    modeNote: string
    efficiencyGrade: EfficiencyGrade | null
    efficiencyNote: string | null
    riseNote: string | null
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
  // Authoritative on/off from a connected thermostat (Nest), when fresh.
  // Used ONLY to gate run-state / mode — never the SEER/cost math.
  hvacStatus?: HvacStatus
  thermostatMode?: ThermostatMode
  // Previous reading's coil delta-T and static, for off-cycle decay detection.
  prevCoolingDeltaF?: number | null
  prevStaticInWc?: number | null
  // Previous reading's furnace stage / season / rise (sequence memory).
  prevFurnaceStage?: FurnaceStage | null
  prevSeasonMode?: SeasonMode | null
  prevRiseF?: number | null
  furnaceSignature?: FurnaceSignature | null
}

const CONDENSER_ON_W = 100
const BLOWER_ON_W = 40
const HEAT_RISE_MIN_F = 8
const COOL_DROP_MIN_F = -4

const toGasType = (v: string | null | undefined): GasType | null =>
  v === "natural_gas" || v === "propane" ? v : null

// On this site the cooling blower tap (~250 W) sits inside the default burn
// band, so the AC's post-run coast (condenser off, blower still on cooling
// tap, cold coil) decodes as a burn. A burn can't make the supply colder than
// the return, and the heat sequence never jumps straight out of a cooling
// blower run, so reclassify those samples.
function guardCoolingCoast(
  furnace: FurnaceStepResult,
  prevStage: FurnaceStage | null,
  riseF: number | null,
  prevRiseF: number | null,
): FurnaceStepResult {
  if (furnace.stage !== "burn") return furnace
  if (riseF != null && riseF >= HEAT_RISE_MIN_F) return furnace
  const coldNow = riseF != null && riseF <= COOL_DROP_MIN_F
  const coldBefore = prevRiseF != null && prevRiseF <= COOL_DROP_MIN_F
  if (prevStage !== "cooling_blower" && !coldNow && !coldBefore) return furnace
  return {
    ...furnace,
    stage: "cooling_blower",
    fire: "unknown",
    burnerOn: false,
    blowerOn: true,
    note: "Blower on the cooling tap coasting after the compressor stopped (cold coil) — not a burn.",
  }
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

  // (a) Furnace sequence decode from the furnace's whole 120 V feed.
  const riseF =
    inputs.supplyTempF != null && inputs.returnTempF != null ? inputs.supplyTempF - inputs.returnTempF : null
  const prevFurnaceStage = options.prevFurnaceStage ?? null
  const furnace = guardCoolingCoast(
    decodeFurnaceStep(
      prevFurnaceStage,
      { furnaceWatts: inputs.furnaceWatts, condenserWatts: inputs.condenserTotalWatts, riseF },
      options.furnaceSignature ?? DEFAULT_FURNACE_SIGNATURE,
    ),
    prevFurnaceStage,
    riseF,
    options.prevRiseF ?? null,
  )

  const condenserOn = inputs.condenserTotalWatts != null && inputs.condenserTotalWatts >= CONDENSER_ON_W
  const blowerOn =
    furnace.blowerOn || (condenserOn && inputs.blowerWatts != null && inputs.blowerWatts > BLOWER_ON_W)

  // (b) Live operating mode.
  const outdoorTempF = options.outdoorTempF ?? null
  const mode = deriveOperatingMode({
    condenserWatts: inputs.condenserTotalWatts,
    furnaceStage: furnace.stage,
    blowerOn,
    riseF,
    thermostatMode: options.thermostatMode ?? null,
    thermostatStatus: (options.hvacStatus ?? null) as ThermostatStatus,
    outdoorTempF,
    lastActiveMode: options.prevSeasonMode ?? null,
  })
  const isCooling = mode.liveMode === "cooling"
  const isHeating = mode.liveMode === "heating"

  // (c) Corroborated run-state. Blower state comes from the decoder, not the
  // 40 W test (the inducer alone exceeds 40 W with the blower off).
  const systemState = deriveSystemState({
    condenserTotalWatts: inputs.condenserTotalWatts,
    blowerWatts: inputs.blowerWatts,
    returnTempF: inputs.returnTempF,
    supplyTempF: inputs.supplyTempF,
    staticInWc: inputs.staticInWc,
    hvacStatus: options.hvacStatus ?? null,
    prevCoolingDeltaF: options.prevCoolingDeltaF ?? null,
    prevStaticInWc: options.prevStaticInWc ?? null,
    blowerOnOverride: blowerOn,
    heating: isHeating,
  })

  // Airflow: heating anchors on the heat tap (heat_cfm), never the cooling
  // anchor. With the blower off mid-heat-call (prepurge/ignition) there is
  // no airflow to claim.
  const airflowBase = {
    staticInWc: inputs.staticInWc,
    tonnage: profile?.system_tonnage,
    cfmPerTon: profile?.cfm_per_ton,
    blowerType: profile?.blower_type,
    blowerModel: profile?.blower_model,
    ecmProfile: profile?.ecm_profile,
    blowerSpeedTap: profile?.blower_speed_tap,
    blowerWatts: inputs.blowerWatts,
  }
  let airflow: AirflowResult
  if (isHeating && !furnace.blowerOn) {
    airflow = {
      ...deriveAirflow({ ...airflowBase, designCfmOverride: profile?.heat_cfm ?? null }),
      cfm: null,
      confidence: "fallback",
      note: `Blower off (${furnace.stage}) — no airflow.`,
    }
  } else if (isHeating) {
    airflow = deriveAirflow({ ...airflowBase, designCfmOverride: profile?.heat_cfm ?? null })
  } else {
    airflow = deriveAirflow(airflowBase)
  }

  // (d) Cooling math only in cooling mode.
  const capacity = isCooling ? capacityFromAirSide(airflow.cfm, returnState, supplyState) : null
  const eff = computeEfficiency(
    capacity?.capacityBtuh ?? null,
    inputs.totalWatts,
    profile?.equipment_class,
    profile?.seer2_conversion_factor,
  )
  const liveEer = isCooling ? eff.liveEer : null
  const measuredSeer2 = isCooling ? eff.measuredSeer2Estimate : null

  // Live electricity cost rate (electric only).
  const cost = computeCost(eff.totalWatts, readingAt)

  const weatherConfidence = options.weatherConfidence ?? null
  const anomaly = isCooling
    ? assessAnomaly({
        liveEer,
        totalWatts: eff.totalWatts,
        systemRunning: systemState.running,
        outdoorTempF,
        weatherConfidence,
        baseline: options.baselineSamples ?? [],
      })
    : null

  // (e) Heating math while burning or purging residual heat.
  let deliveredBtuh: number | null = null
  let gasInputBtuh: number | null = null
  let thermalEffPct: number | null = null
  let riseVerdict: RiseVerdict | null = null
  let riseNote: string | null = null
  let efficiencyGrade: EfficiencyGrade | null = null
  let efficiencyNote: string | null = null

  if (isHeating && (furnace.burnerOn || furnace.stage === "post_purge")) {
    const commissioning: FurnaceCommissioning = {
      gas_type: toGasType(profile?.gas_type),
      heating_value_btu_per_cuft: profile?.gas_heating_value_btu_per_cuft ?? null,
      input_low_fire_btuh: profile?.furnace_input_low_fire_btuh ?? null,
      input_high_fire_btuh: profile?.furnace_input_high_fire_btuh ?? null,
      input_nameplate_btuh: profile?.furnace_input_nameplate_btuh ?? null,
      afue_rated_pct: profile?.furnace_afue_rated_pct ?? null,
      condensing: profile?.furnace_condensing ?? null,
      rise_min_f: profile?.furnace_rise_min_f ?? null,
      rise_max_f: profile?.furnace_rise_max_f ?? null,
    }

    deliveredBtuh = heatingCapacityFromAirSide(airflow.cfm, returnState, inputs.supplyTempF).deliveredBtuh

    if (furnace.burnerOn) {
      gasInputBtuh = inputBtuhForFire(furnace.fire, commissioning).inputBtuh
      thermalEffPct = liveThermalEfficiencyPct(deliveredBtuh, gasInputBtuh)
      const rise = checkTemperatureRise(riseF, commissioning.rise_min_f, commissioning.rise_max_f)
      riseVerdict = rise.verdict
      riseNote = rise.note
      const grade = gradeLiveEfficiency(thermalEffPct, commissioning.afue_rated_pct, commissioning.condensing)
      efficiencyGrade = grade.grade
      efficiencyNote = grade.note
    } else {
      gasInputBtuh = 0
    }
  }

  // (g) Gas cost: input BTU/h -> therms/h -> $/h. 0 when the burner is off.
  const gasRate = profile?.gas_rate_per_therm ?? null
  const gasCostPerHour = furnace.burnerOn
    ? gasInputBtuh != null && gasRate != null
      ? (gasInputBtuh / 100000) * gasRate
      : null
    : 0

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
    capacity_btuh: capacity?.capacityBtuh ?? null,
    total_watts: eff.totalWatts,
    live_eer: liveEer,
    measured_seer2_estimate: measuredSeer2,

    coil_state: coil.state,

    system_running: systemState.running,
    system_state: systemState.state,
    cooling_delta_f: systemState.coolingDeltaF,
    sensor_faults: systemState.faults,

    operating_mode: mode.liveMode,
    season_mode: mode.seasonMode,
    mode_source: mode.liveSource,
    furnace_stage: furnace.stage,
    fire_stage: furnace.burnerOn ? furnace.fire : null,
    mode_disagreements: mode.disagreements,

    temp_rise_f: isHeating ? riseF : null,
    delivered_btuh: deliveredBtuh,
    gas_input_btuh: gasInputBtuh,
    live_thermal_eff_pct: thermalEffPct,
    rise_verdict: riseVerdict,

    tou_season: cost.season,
    tou_period: cost.tou_period,
    rate_per_kwh: cost.rate_per_kwh,
    cost_per_hour: cost.cost_per_hour,
    gas_cost_per_hour: gasCostPerHour,

    barometric_pressure_inhg: liveP,

    outdoor_temp_f: outdoorTempF,
    weather_confidence: weatherConfidence,

    efficiency_color: anomaly?.color ?? "idle",

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
      systemOffCycle: systemState.offCycle,
      systemBasis: systemState.basis,
      pressureSource,
      anomalyNote: anomaly?.note ?? `Not cooling (${mode.liveMode}) — cooling efficiency not scored.`,
      anomalyDeviationPct: anomaly?.deviationPct ?? null,
      anomalyBaselineEer: anomaly?.baselineEer ?? null,
      anomalyBaselineSamples: anomaly?.baselineSampleCount ?? 0,
      anomalyCapped: anomaly?.capped ?? false,
      furnaceNote: furnace.note,
      modeNote: mode.note,
      efficiencyGrade,
      efficiencyNote,
      riseNote,
      matched: inputs.matched,
    },
  }
}
