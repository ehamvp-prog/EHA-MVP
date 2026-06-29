// =====================================================================
// System run-state — CORROBORATED from multiple independent signals.
//
// The old logic decided "on vs off" from a single number (summed watts).
// A single missed power reading then collapsed the whole app to
// "System is off." That is fragile and dishonest.
//
// The honest model:
//   - COOLING is proven by the compressor drawing real power OR a real
//     return-minus-supply temperature drop across the coil. These are the
//     two independent proofs of active cooling.
//   - The blower (air handler) is a SUPPORTING signal: it must run for
//     cooling to happen, but on its own it only means air circulation
//     (fan mode), NOT cooling.
//
// OFF-CYCLE (call satisfied): a refrigerant coil stays cold for a while
// after the compressor stops, so the supply air keeps showing a real
// temperature drop AFTER the call for cool ends. That residual cooling is
// NORMAL and must NOT be flagged as a "condenser has no power" fault.
// We recognize the off cycle when the compressor power is gone AND the
// evidence is FADING — the coil delta-T is decaying and/or static pressure
// has dropped (blower winding down). When a thermostat is connected, its
// reported HVAC status is authoritative for on/off and we trust it directly.
//
// When signals genuinely CONTRADICT during an ACTIVE call (compressor
// pulling power but blower reads 0 W; a real, SUSTAINED coil delta-T but
// the condenser reads ~0 W; blower clearly running but static reads ~0), we
// do NOT silently pick one — we keep the system running on the strong
// evidence AND raise a sensor-fault flag describing the contradiction.
// =====================================================================

export type SystemRunState = "cooling" | "fan_only" | "off" | "fault"

// Nest/thermostat reported HVAC status, when a thermostat is connected.
export type HvacStatus = "HEATING" | "COOLING" | "OFF" | null

export interface SystemStateInputs {
  condenserTotalWatts: number | null
  blowerWatts: number | null
  returnTempF: number | null
  supplyTempF: number | null
  staticInWc: number | null
  // Authoritative on/off from a connected thermostat (Nest). When present,
  // this decides cooling vs not — sensor inference is only a fallback.
  hvacStatus?: HvacStatus
  // Previous reading's coil delta-T and static, used to detect a DECAYING
  // (off-cycle) trend versus a sustained, genuine contradiction.
  prevCoolingDeltaF?: number | null
  prevStaticInWc?: number | null
}

export interface SensorFault {
  code: string
  severity: "warn" | "fault"
  message: string
}

export interface SystemStateResult {
  running: boolean // actively cooling (for efficiency scoring)
  state: SystemRunState
  basis: string[] // human-readable signals behind the verdict
  faults: SensorFault[]
  coolingDeltaF: number | null // return - supply (positive while cooling)
  offCycle: boolean // call satisfied; coil coasting (residual cooling)
  note: string
}

// --- Tunable thresholds (documented) ---------------------------------

// Real condenser/compressor power draw (W). Above this = compressor on.
const CONDENSER_ON_WATTS = 100
// Real blower power draw (W). PSC/ECM blowers idle far above 0 when on.
const BLOWER_ON_WATTS = 40
// Minimum return-minus-supply temperature drop (F) that proves cooling.
const COOLING_DELTA_MIN_F = 4
// Below this static while the blower is clearly running, the transducer is
// almost certainly disconnected or the sensing tap is blocked.
const LOW_STATIC_MIN_INWC = 0.05
// Coil delta-T must fall by at least this much (F) between readings to count
// as a decaying off-cycle rather than steady cooling.
const DELTA_DECAY_MIN_F = 0.3
// Static pressure dropping by at least this much (in. WC) between readings
// signals the blower winding down (call ended).
const STATIC_DROP_MIN_INWC = 0.05

export function deriveSystemState(inputs: SystemStateInputs): SystemStateResult {
  const {
    condenserTotalWatts,
    blowerWatts,
    returnTempF,
    supplyTempF,
    staticInWc,
    hvacStatus = null,
    prevCoolingDeltaF = null,
    prevStaticInWc = null,
  } = inputs

  const condReading = condenserTotalWatts != null
  const blowerReading = blowerWatts != null
  const condenserActive = condReading && (condenserTotalWatts as number) >= CONDENSER_ON_WATTS
  const blowerActive = blowerReading && (blowerWatts as number) >= BLOWER_ON_WATTS

  const coolingDeltaF =
    returnTempF != null && supplyTempF != null ? returnTempF - supplyTempF : null
  const coolingByAir = coolingDeltaF != null && coolingDeltaF >= COOLING_DELTA_MIN_F

  // Is the residual cooling evidence FADING? Decaying delta-T or a dropping
  // static pressure both indicate the compressor/blower are spinning down.
  const deltaDecaying =
    coolingDeltaF != null &&
    prevCoolingDeltaF != null &&
    coolingDeltaF < prevCoolingDeltaF - DELTA_DECAY_MIN_F
  const staticDropped =
    staticInWc != null &&
    prevStaticInWc != null &&
    staticInWc < prevStaticInWc - STATIC_DROP_MIN_INWC

  // Thermostat authority: when connected, its status decides cooling on/off.
  const thermostatConnected = hvacStatus != null
  const thermostatCooling = hvacStatus === "COOLING"

  let cooling: boolean
  let offCycle = false

  if (thermostatConnected) {
    // Trust the thermostat for on/off. Any residual coil delta-T while it
    // reports not-cooling is the coil coasting — an off cycle, not a fault.
    cooling = thermostatCooling
    if (!cooling && coolingByAir) offCycle = true
  } else {
    // No thermostat: infer the off cycle from the sensors. Compressor power
    // gone + fading evidence (decaying delta-T or dropping static) = the call
    // for cool has ended and the coil is simply coasting.
    const residualCoilDecay = !condenserActive && coolingByAir && (deltaDecaying || staticDropped)
    if (residualCoilDecay) {
      cooling = false
      offCycle = true
    } else {
      cooling = condenserActive || coolingByAir
    }
  }

  const fanOnly = !cooling && blowerActive

  const basis: string[] = []
  if (thermostatConnected && thermostatCooling) basis.push("thermostat is calling for cool")
  if (condenserActive) basis.push(`condenser drawing ${Math.round(condenserTotalWatts as number)} W`)
  if (cooling && coolingByAir) basis.push(`${(coolingDeltaF as number).toFixed(1)}°F drop across the coil`)
  if (cooling && blowerActive) basis.push(`blower energized (${Math.round(blowerWatts as number)} W)`)

  const faults: SensorFault[] = []

  // --- Cross-checks: only when ACTIVELY cooling (never during an off cycle) ---
  if (cooling) {
    // Compressor on, but the blower has a reading that says it's off.
    if (condenserActive && blowerReading && !blowerActive) {
      faults.push({
        code: "blower_no_power",
        severity: "fault",
        message:
          "Compressor is drawing power but the blower reads no power — possible blower CT/sensor fault or a stopped fan.",
      })
    }
    // A real, SUSTAINED coil delta-T proves cooling, but the condenser reads
    // ~off. Only a fault when the evidence is NOT fading (a fading delta-T is
    // a normal off cycle and was already routed to offCycle above).
    if (coolingByAir && condReading && !condenserActive && !deltaDecaying && !staticDropped) {
      faults.push({
        code: "condenser_no_power",
        severity: "fault",
        message:
          "The coil shows a sustained temperature drop but the condenser reads no power — possible condenser CT/sensor fault.",
      })
    }
    // Compressor on, both air temps present, but no real temperature drop.
    if (condenserActive && coolingDeltaF != null && !coolingByAir) {
      faults.push({
        code: "no_delta_t",
        severity: "warn",
        message: `Equipment is energized but only a ${coolingDeltaF.toFixed(
          1,
        )}°F drop across the coil — check refrigerant charge, coil, or the air-temp sensors.`,
      })
    }
    // Cooling, blower clearly running, but static pressure reads near zero.
    if (blowerActive && staticInWc != null && staticInWc < LOW_STATIC_MIN_INWC) {
      faults.push({
        code: "low_static",
        severity: "fault",
        message: `Blower is running but static pressure reads ${staticInWc.toFixed(
          2,
        )} in. WC (near zero) — the transducer may be disconnected or the tap blocked.`,
      })
    }
  }

  const state: SystemRunState = cooling
    ? faults.some((f) => f.severity === "fault")
      ? "fault"
      : "cooling"
    : fanOnly
      ? "fan_only"
      : "off"

  const note = cooling
    ? state === "fault"
      ? `Cooling detected (${basis.join("; ")}), but ${faults.length} sensor issue${
          faults.length > 1 ? "s" : ""
        } flagged.`
      : `Actively cooling — ${basis.join("; ")}.`
    : offCycle
      ? `Cooling call satisfied — compressor off, coil coasting${
          coolingDeltaF != null ? ` (residual ${coolingDeltaF.toFixed(1)}°F drop fading)` : ""
        }.`
      : fanOnly
        ? `Blower is running (${Math.round(
            blowerWatts as number,
          )} W) but the compressor is off — fan/circulation only, not cooling.`
        : thermostatConnected
          ? "Thermostat reports the system is off."
          : "No compressor power or coil temperature drop detected — system is off."

  // `running` drives efficiency scoring: only true while actually cooling.
  return { running: cooling, state, basis, faults, coolingDeltaF, offCycle, note }
}
