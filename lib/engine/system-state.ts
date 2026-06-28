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
// So:
//   - condenser power OR real delta-T            -> actively cooling
//   - blower only (no compressor, no delta-T)    -> fan / off (not cooling)
//   - nothing                                    -> off
//
// When signals CONTRADICT (compressor pulling power but blower reads 0 W;
// a real coil delta-T but the condenser reads ~0 W; blower clearly running
// but static reads ~0), we do NOT silently pick one — we keep the system
// running on the strong evidence AND raise a sensor-fault flag describing
// the contradiction so it can be investigated instead of hidden.
// =====================================================================

export type SystemRunState = "cooling" | "fan_only" | "off" | "fault"

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
  running: boolean // actively cooling (for efficiency scoring)
  state: SystemRunState
  basis: string[] // human-readable signals behind the verdict
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

  // Cooling is proven ONLY by the compressor or a real coil delta-T.
  // The blower running is supporting evidence, not proof of cooling.
  const cooling = condenserActive || coolingByAir
  const fanOnly = !cooling && blowerActive

  const basis: string[] = []
  if (condenserActive) basis.push(`condenser drawing ${Math.round(condenserTotalWatts as number)} W`)
  if (coolingByAir) basis.push(`${(coolingDeltaF as number).toFixed(1)}°F drop across the coil`)
  if (cooling && blowerActive) basis.push(`blower energized (${Math.round(blowerWatts as number)} W)`)

  const faults: SensorFault[] = []

  // --- Cross-checks: only meaningful when the system is actually cooling ---
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
    // A real coil delta-T proves cooling, but the condenser reads ~off.
    if (coolingByAir && condReading && !condenserActive) {
      faults.push({
        code: "condenser_no_power",
        severity: "fault",
        message:
          "The coil shows a real temperature drop but the condenser reads no power — possible condenser CT/sensor fault.",
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

  const note =
    state === "cooling"
      ? `Actively cooling — ${basis.join("; ")}.`
      : state === "fault"
        ? `Cooling detected (${basis.join("; ")}), but ${faults.length} sensor issue${
            faults.length > 1 ? "s" : ""
          } flagged.`
        : state === "fan_only"
          ? `Blower is running (${Math.round(
              blowerWatts as number,
            )} W) but the compressor is off — fan/circulation only, not cooling.`
          : "No compressor power or coil temperature drop detected — system is off."

  // `running` drives efficiency scoring: only true while actually cooling.
  return { running: cooling, state, basis, faults, coolingDeltaF, note }
}
