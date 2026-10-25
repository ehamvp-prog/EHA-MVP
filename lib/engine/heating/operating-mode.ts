// =====================================================================
// Operating mode — the brain's first question every tick:
// "what is this system doing right now, and what is it set up to do?"
//
// Two different things both get called "mode". Keep them apart:
//
//   liveMode   : what is RUNNING this instant (heating / cooling / fan /
//                off). Minute to minute. Decides which efficiency math
//                runs on THIS reading and which run-state is scored.
//
//   seasonMode : what the system is SET UP to do (heat or cool). Slow and
//                stable. Decides which tile set the Home screen shows by
//                default and which automation brain is in charge. Shown to
//                the user as "System auto detects heating/cooling".
//
// Kansas shoulder season will cool at 3 pm and heat at 6 am on the same
// day, so neither is a switch someone flips in October — both are decided
// per tick, in this order of trust:
//
//   1. Live sensors — the condenser pulling power / the furnace sequence
//      running / the SIGN of supply−return. These say what is actually
//      happening. A thermostat only says what it is ASKING for.
//   2. The thermostat — corroboration, and the answer when nothing is
//      running (its mode is the best read of seasonMode).
//   3. Outdoor temperature — tie-break only.
//
// Disagreement between 1 and 2 is worth more than agreement: the stat says
// HEATING and no heat shows up = a furnace that isn't lighting; the stat
// says COOLING and the condenser is dark = contactor / breaker / sensor.
// Nobody else catches that because nobody else watches both sides.
// =====================================================================

import type { FurnaceStage } from "./furnace-sequence"

export type LiveMode = "heating" | "cooling" | "fan_only" | "off" | "unknown"
export type SeasonMode = "heating" | "cooling"
export type ModeSource = "sensors" | "thermostat" | "outdoor" | "default"

export type ThermostatMode = "HEAT" | "COOL" | "HEATCOOL" | "OFF" | null
export type ThermostatStatus = "HEATING" | "COOLING" | "OFF" | null

export interface OperatingModeInputs {
  condenserWatts: number | null
  furnaceStage: FurnaceStage | null // from decodeFurnaceStep
  blowerOn: boolean
  riseF: number | null // supply − return
  thermostatMode: ThermostatMode
  thermostatStatus: ThermostatStatus
  outdoorTempF: number | null
  // Last confirmed live heating/cooling mode (from the previous reading),
  // used to keep seasonMode steady through fan-only and off periods.
  lastActiveMode?: SeasonMode | null
}

export interface ModeDisagreement {
  code: "stat_heating_no_heat" | "stat_cooling_no_condenser" | "heat_without_call" | "cool_without_call"
  message: string
}

export interface OperatingModeResult {
  liveMode: LiveMode
  liveSource: ModeSource
  seasonMode: SeasonMode
  seasonSource: ModeSource
  disagreements: ModeDisagreement[]
  note: string
}

// Real condenser power = cooling. Same threshold as system-state.ts.
const CONDENSER_ON_W = 100
// supply − return at/above this proves heat in the duct …
const HEAT_RISE_MIN_F = 8
// … and at/below this (i.e. a 4 °F+ DROP) proves cooling. Same as system-state.
const COOL_DROP_MIN_F = -4
// Outdoor tie-break: below this it is a heating day, above it a cooling day.
const OUTDOOR_HEAT_BELOW_F = 60

const HEAT_STAGES: FurnaceStage[] = ["prepurge", "ignition", "burn", "post_purge"]

export function deriveOperatingMode(i: OperatingModeInputs): OperatingModeResult {
  const condenserOn = i.condenserWatts != null && i.condenserWatts >= CONDENSER_ON_W
  const furnaceCalling = i.furnaceStage != null && HEAT_STAGES.includes(i.furnaceStage)
  const burning = i.furnaceStage === "burn" || i.furnaceStage === "ignition"
  const heatInDuct = i.riseF != null && i.riseF >= HEAT_RISE_MIN_F
  const coolInDuct = i.riseF != null && i.riseF <= COOL_DROP_MIN_F

  // ---- 1. Live mode from sensors -------------------------------------
  let liveMode: LiveMode = "unknown"
  let liveSource: ModeSource = "default"

  // A heat pump heats WITH the condenser running: condenser on + a hot
  // supply is heating, not cooling. The sign of the rise settles it.
  if (condenserOn && heatInDuct && !coolInDuct) {
    liveMode = "heating"
    liveSource = "sensors"
  } else if (condenserOn || (coolInDuct && !furnaceCalling)) {
    liveMode = "cooling"
    liveSource = "sensors"
  } else if (furnaceCalling || heatInDuct) {
    liveMode = "heating"
    liveSource = "sensors"
  } else if (i.thermostatStatus === "HEATING") {
    // Stat is calling, sensors quiet (yet). Trust the stat for the first
    // minute of a call; the disagreement check below handles "still quiet".
    liveMode = "heating"
    liveSource = "thermostat"
  } else if (i.thermostatStatus === "COOLING") {
    liveMode = "cooling"
    liveSource = "thermostat"
  } else if (i.blowerOn) {
    liveMode = "fan_only"
    liveSource = "sensors"
  } else {
    liveMode = "off"
    liveSource = i.thermostatStatus != null ? "thermostat" : "sensors"
  }

  // ---- 2. Season mode: what the system is set up to do -----------------
  let seasonMode: SeasonMode
  let seasonSource: ModeSource
  if (liveMode === "heating" || liveMode === "cooling") {
    seasonMode = liveMode
    seasonSource = liveSource
  } else if (i.thermostatMode === "HEAT") {
    seasonMode = "heating"
    seasonSource = "thermostat"
  } else if (i.thermostatMode === "COOL") {
    seasonMode = "cooling"
    seasonSource = "thermostat"
  } else if (i.lastActiveMode) {
    // HEATCOOL / OFF / no stat: stay with whatever last actually ran.
    seasonMode = i.lastActiveMode
    seasonSource = "sensors"
  } else if (i.outdoorTempF != null) {
    seasonMode = i.outdoorTempF < OUTDOOR_HEAT_BELOW_F ? "heating" : "cooling"
    seasonSource = "outdoor"
  } else {
    seasonMode = "cooling"
    seasonSource = "default"
  }

  // ---- 3. Disagreements — the valuable part ---------------------------
  const disagreements: ModeDisagreement[] = []
  if (i.thermostatStatus === "HEATING" && !furnaceCalling && !heatInDuct) {
    disagreements.push({
      code: "stat_heating_no_heat",
      message: "Thermostat is calling for heat but the furnace isn't running and there's no heat in the duct — possible ignition failure, pressure-switch trip, or a tripped limit.",
    })
  }
  if (i.thermostatStatus === "COOLING" && !condenserOn && !coolInDuct) {
    disagreements.push({
      code: "stat_cooling_no_condenser",
      message: "Thermostat is calling for cool but the condenser reads no power and the coil isn't cold — check the contactor, breaker, or condenser sensor.",
    })
  }
  if (burning && i.thermostatStatus != null && i.thermostatStatus !== "HEATING") {
    disagreements.push({
      code: "heat_without_call",
      message: "The furnace is burning but the thermostat isn't calling for heat — stuck relay/gas valve or a thermostat-wiring issue.",
    })
  }
  if (condenserOn && !heatInDuct && i.thermostatStatus != null && i.thermostatStatus !== "COOLING") {
    disagreements.push({
      code: "cool_without_call",
      message: "The condenser is running but the thermostat isn't calling for cool — stuck contactor or a thermostat-wiring issue.",
    })
  }

  const note =
    liveMode === "heating"
      ? `Heating now (${liveSource}); system auto detects heating.`
      : liveMode === "cooling"
        ? `Cooling now (${liveSource}); system auto detects cooling.`
        : liveMode === "fan_only"
          ? `Fan only; system auto detects ${seasonMode} (${seasonSource}).`
          : `Idle; system auto detects ${seasonMode} (${seasonSource}).`

  return { liveMode, liveSource, seasonMode, seasonSource, disagreements, note }
}
