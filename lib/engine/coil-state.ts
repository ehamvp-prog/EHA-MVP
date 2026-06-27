// =====================================================================
// Coil state is DERIVED from live conditions, never set by hand.
//
// Rule (per installer guidance):
//   - WET  : the condenser is drawing power (system is actively cooling,
//            so the indoor coil is cold and pulling humidity).
//   - DRY  : no condenser power AND the humidity difference across the
//            coil (return RH vs supply RH) has collapsed to near zero,
//            meaning the coil is no longer removing moisture.
//   - UNKNOWN: not enough data to decide yet.
//
// We use RH gap (return - supply). When cooling, the supply air is much
// more saturated than the return, so the gap is large and positive. As
// the coil dries out and airflow continues, that gap shrinks toward 0.
// =====================================================================

export type CoilState = "wet" | "dry" | "unknown"

// If the two RH readings are within this many percent of each other (and
// there is no condenser power), the coil is considered dry.
const RH_GAP_DRY_THRESHOLD = 5 // percentage points

// Treat anything above this as real condenser power draw (watts).
const CONDENSER_ON_WATTS = 50

export interface CoilStateInputs {
  condenserWattsLeg1: number | null
  condenserWattsLeg2: number | null
  returnRh: number | null
  supplyRh: number | null
}

export interface CoilStateResult {
  state: CoilState
  note: string
  condenserOn: boolean
  rhGap: number | null
}

export function deriveCoilState(inputs: CoilStateInputs): CoilStateResult {
  const legs = [inputs.condenserWattsLeg1, inputs.condenserWattsLeg2].filter(
    (w): w is number => typeof w === "number" && Number.isFinite(w),
  )
  const condenserWatts = legs.length > 0 ? legs.reduce((a, b) => a + b, 0) : null

  // Condenser power tells us cooling is happening -> wet coil.
  if (condenserWatts != null && condenserWatts > CONDENSER_ON_WATTS) {
    return {
      state: "wet",
      note: `Condenser drawing ${Math.round(condenserWatts)} W — system is cooling, coil is wet.`,
      condenserOn: true,
      rhGap: gap(inputs.returnRh, inputs.supplyRh),
    }
  }

  // No condenser power. Look at the humidity gap across the coil.
  const rhGap = gap(inputs.returnRh, inputs.supplyRh)

  if (rhGap == null) {
    return {
      state: "unknown",
      note: "No condenser power and not enough humidity data to judge the coil.",
      condenserOn: false,
      rhGap: null,
    }
  }

  if (Math.abs(rhGap) <= RH_GAP_DRY_THRESHOLD) {
    return {
      state: "dry",
      note: `No condenser power and humidity across the coil is nearly equal (${rhGap.toFixed(1)} pts) — coil is dry.`,
      condenserOn: false,
      rhGap,
    }
  }

  // No power but the coil is still saturated (recently shut off, draining).
  return {
    state: "wet",
    note: `Condenser off but coil still holds moisture (${rhGap.toFixed(1)} pt humidity gap).`,
    condenserOn: false,
    rhGap,
  }
}

function gap(returnRh: number | null, supplyRh: number | null): number | null {
  if (returnRh == null || supplyRh == null) return null
  // Supply is typically more saturated than return while cooling, so this
  // is usually negative; we report supply - return for an intuitive sign.
  return supplyRh - returnRh
}
