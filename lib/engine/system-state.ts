// =====================================================================
// System run-state — CORROBORATED from multiple independent signals.
//
// The old logic decided "on vs off" from a single number (summed watts).
// A single missed power reading then collapsed the whole app to
// "System is off." That is fragile and dishonest.
//
// Instead we treat the system as ACTIVELY COOLING if ANY strong signal
// says so:
//   - condenser/compressor drawing real power, OR
//   - blower (air handler) energized, OR
//   - supply air measurably colder than return (a real delta-T).
//
// When signals DISAGREE (e.g. compressor pulling 1.8 kW but the blower
// reads 0 W, or the blower is running while static pressure reads ~0), we
// do NOT silently pick one. We mark the system running on the strong
// evidence AND raise a sensor-fault flag describing the contradiction so
// it can be investigated instead of hidden.
// =====================================================================

export type SystemRunState = "cooling" | "off" | "fault"

export interface SystemStateInputs {
  condenserTotalWatts: number | null
  blowerWatts: number | null
  returnTempF: number | null
  supplyTempF: number | null
  staticInWc: number | null
}

export interface SensorFault {
  code: string
  severity: "warn" | "fault"
  message: string
}

export interface SystemStateResult {
  running: boolean
  state: SystemRunState
  basis: string[] // human-readable signals that indicate the system is cooling
  faults: SensorFault[]
  coolingDeltaF: number | null // return - supply (positive while cooling)
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

export function deriveSystemState(inputs: SystemStateInputs): SystemStateResult {
  const { condenserTotalWatts, blowerWatts, returnTempF, supplyTempF, staticInWc } = inputs

  const condReading = condenserTotalWatts != null
  const blowerReading = blowerWatts != null
  const condenserActive = condReading && (condenserTotalWatts as number) >= CONDENSER_ON_WATTS
  const blowerActive = blowerReading && (blowerWatts as number) >= BLOWER_ON_WATTS

  const coolingDeltaF =
    returnTempF != null && supplyTempF != null ? returnTempF - supplyTempF : null
  const coolingByAir = coolingDeltaF != null && coolingDeltaF >= COOLING_DELTA_MIN_F

  const basis: string[] = []
  if (condenserActive) basis.push(`condenser drawing ${Math.round(condenserTotalWatts as number)} W`)
  if (blowerActive) basis.push(`blower energized (${Math.round(blowerWatts as number)} W)`)
  if (coolingByAir) basis.push(`${(coolingDeltaF as number).toFixed(1)}°F drop across the coil`)

  const running = basis.length > 0
  const faults: SensorFault[] = []

  // --- Cross-checks: only meaningful when SOMETHING says it's running ---
  if (running) {
    // Compressor on, but blower has a reading that says it's off.
    if (condenserActive && blowerReading && !blowerActive) {
      faults.push({
        code: "blower_no_power",
        severity: "fault",
        message:
          "Compressor is drawing power but the blower reads no power — possible blower CT/sensor fault or a stopped fan.",
      })
    }
    // Blower (or delta-T) says cooling, but condenser has a reading of ~off.
    if ((blowerActive || coolingByAir) && condReading && !condenserActive) {
      faults.push({
        code: "condenser_no_power",
        severity: "fault",
        message:
          "Blower/airflow indicate cooling but the condenser reads no power — possible condenser CT/sensor fault.",
      })
    }
    // Running, both air temps present, but no real temperature drop.
    if (coolingDeltaF != null && !coolingByAir && (condenserActive || blowerActive)) {
      faults.push({
        code: "no_delta_t",
        severity: "warn",
        message: `Equipment is energized but only a ${coolingDeltaF.toFixed(
          1,
        )}°F drop across the coil — check refrigerant charge, coil, or the air temp sensors.`,
      })
    }
    // Blower clearly running but static pressure reads near zero.
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

  const state: SystemRunState = !running ? "off" : faults.some((f) => f.severity === "fault") ? "fault" : "cooling"

  const note = !running
    ? "No condenser power, blower power, or temperature drop detected — system is off."
    : faults.length > 0
      ? `Cooling detected (${basis.join("; ")}), but ${faults.length} sensor issue${
          faults.length > 1 ? "s" : ""
        } flagged.`
      : `Actively cooling — ${basis.join("; ")}.`

  return { running, state, basis, faults, coolingDeltaF, note }
}
