// =====================================================================
// Airflow (CFM) derivation — STATIC PRESSURE + BLOWER CURVE ONLY.
//
// This stack has NO refrigerant-side probes, ever. There is no
// independent air-side airflow solution (the enthalpy equation has two
// unknowns: airflow AND capacity). So the air-side "measured" tier does
// not exist in this build. Airflow comes from the static pressure path.
//
// Confidence states (best -> weakest):
//
//   "static_oem"     : static pressure read against a real OEM blower
//                      table for the entered furnace/air-handler model.
//                      Tightest, most defensible. (Used when a table
//                      exists for the model; none are bundled yet.)
//   "ecm_commanded"  : constant-airflow ECM. The motor holds its commanded
//                      (design) CFM across its rated static range, so CFM =
//                      tonnage * cfm_per_ton. Static is NOT used to reduce
//                      CFM here (that would be PSC behavior); it only flags
//                      operation beyond the ECM's rated static limit. Live
//                      blower watts validate that the motor is holding.
//   "static_derived" : PSC / fixed-speed blower read against a GENERALIZED
//                      blower curve anchored to design airflow. Honest
//                      approximation, far better than a fixed number.
//   "fallback"       : no static reading or no tonnage. Airflow is
//                      UNKNOWN -> returned null, and downstream
//                      capacity/EER/SEER2 stay blank.
//
// Generalized PSC / blower curve (the static_derived path):
//   - Design point: rated CFM (tonnage * cfm_per_ton) at DESIGN static.
//   - Above design static: about -10% CFM per +0.1" WC.
//   - Below design static: about  +8% CFM per -0.1" WC.
//   This is a simple fan-law-style slope, replaced by the OEM table
//   when the exact model is known.
//
// The nominal rated CFM is also kept as an outer-bounds reference.
// =====================================================================

export type AirflowConfidence =
  | "static_oem" // static read against a real OEM blower table
  | "ecm_commanded" // constant-airflow ECM holding its commanded CFM
  | "static_derived" // PSC/fixed-speed read against the generalized curve
  | "fallback" // airflow unknown

export interface AirflowResult {
  cfm: number | null // usable airflow for capacity; null when fallback
  confidence: AirflowConfidence
  ratedCfm: number | null // tonnage * cfm_per_ton, design-point reference
  staticInWc: number | null
  staticFlag: "normal" | "high" | "unknown" // sanity vs blower
  generalizedModel: boolean // true when using the generalized curve (not OEM)
  note: string
}

// Design static pressure (total external static) the curve anchors to.
const DESIGN_STATIC_INWC = 0.5
// Slope of the generalized curve, per 0.1" WC away from design static.
const SLOPE_ABOVE = 0.1 // -10% CFM per +0.1" WC above design
const SLOPE_BELOW = 0.08 // +8% CFM per -0.1" WC below design
// A reasonable upper bound for total external static on residential gear.
const HIGH_STATIC_INWC = 0.8
// Keep the curve within sane physical bounds.
const FACTOR_MIN = 0.4
const FACTOR_MAX = 1.6

// --- Constant-airflow ECM behavior ---------------------------------------
// A constant-CFM ECM is DESIGNED to hold its commanded airflow across the
// manufacturer's rated external-static range. It does this by drawing MORE
// power as static rises (the opposite of a PSC, which loses CFM). So within
// this range we hold commanded CFM and do NOT apply any fan-law downslope.
// Typical residential ECM max rated external static is ~0.8" WC; above that
// the motor MAY begin to fall off its target, which we flag (not silently
// halve). Confirm the exact limit from the blower's spec sheet when known.
const ECM_MAX_RATED_STATIC_INWC = 0.8
// Minimum live blower watts that indicate the ECM is energized and working
// to hold airflow. Below this we can't confirm it's holding commanded CFM.
const ECM_ENERGIZED_MIN_W = 40

interface AirflowInputs {
  staticInWc: number | null | undefined
  tonnage: number | null | undefined
  cfmPerTon: number | null | undefined
  blowerType: string | null | undefined // 'furnace' | 'air_handler'
  blowerModel: string | null | undefined // exact model -> OEM table if known
  ecmProfile: string | null | undefined // presence implies ECM/variable
  blowerSpeedTap: string | null | undefined
  blowerWatts?: number | null | undefined // live blower power, ECM validity signal
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function ratedCfmOf(
  tonnage: number | null | undefined,
  cfmPerTon: number | null | undefined,
): number | null {
  if (tonnage == null || cfmPerTon == null) return null
  if (!Number.isFinite(tonnage) || !Number.isFinite(cfmPerTon)) return null
  if (tonnage <= 0 || cfmPerTon <= 0) return null
  return tonnage * cfmPerTon
}

/** Is this an ECM / variable-speed blower? ECM targets a commanded CFM. */
function isEcm(ecmProfile?: string | null): boolean {
  return typeof ecmProfile === "string" && ecmProfile.trim().length > 0
}

/**
 * OEM blower-table lookup hook. Returns a CFM when a real table exists
 * for the model/tap/static, otherwise null. No tables are bundled yet,
 * so this currently always returns null — but the path is wired so that
 * dropping in real tables upgrades confidence to "static_oem" with no
 * other code changes.
 */
function lookupOemTableCfm(_input: AirflowInputs): number | null {
  return null
}

/**
 * Generalized blower curve: anchor to rated (design) CFM at design
 * static, then apply the fan-law-style slope away from design.
 */
function generalizedCurveCfm(ratedCfm: number, staticInWc: number): number {
  const steps = (staticInWc - DESIGN_STATIC_INWC) / 0.1
  const slope = steps >= 0 ? SLOPE_ABOVE : SLOPE_BELOW
  const factor = clamp(1 - slope * steps, FACTOR_MIN, FACTOR_MAX)
  return ratedCfm * factor
}

export function deriveAirflow(input: AirflowInputs): AirflowResult {
  const rated = ratedCfmOf(input.tonnage, input.cfmPerTon)
  const staticInWc =
    input.staticInWc != null && Number.isFinite(input.staticInWc)
      ? input.staticInWc
      : null

  // No static reading -> cannot derive airflow on this stack. Fallback.
  if (staticInWc == null) {
    return {
      cfm: null,
      confidence: "fallback",
      ratedCfm: rated,
      staticInWc: null,
      staticFlag: "unknown",
      generalizedModel: false,
      note: "No static pressure reading. Airflow unknown; capacity left blank.",
    }
  }

  // No tonnage/cfm-per-ton -> no design anchor to build a curve from.
  if (rated == null) {
    return {
      cfm: null,
      confidence: "fallback",
      ratedCfm: null,
      staticInWc,
      staticFlag: staticInWc > HIGH_STATIC_INWC ? "high" : "normal",
      generalizedModel: false,
      note: "No tonnage / airflow-per-ton in profile. Airflow unknown; capacity left blank.",
    }
  }

  const staticFlag: AirflowResult["staticFlag"] =
    staticInWc > HIGH_STATIC_INWC ? "high" : "normal"

  // Best path: a real OEM blower table for the entered model.
  const oemCfm = lookupOemTableCfm(input)
  if (oemCfm != null) {
    return {
      cfm: oemCfm,
      confidence: "static_oem",
      ratedCfm: rated,
      staticInWc,
      staticFlag,
      generalizedModel: false,
      note: "Airflow from OEM blower table at measured static.",
    }
  }

  // Constant-airflow ECM: the motor HOLDS its commanded (design) CFM across
  // its rated static range by spending more watts as static rises — it does
  // NOT lose airflow to a fan-law downslope the way a PSC does. So CFM =
  // commanded design airflow (rated). Blower watts are the validity signal,
  // and static is only used to flag operation beyond the ECM's rated limit.
  if (isEcm(input.ecmProfile)) {
    const blowerW =
      input.blowerWatts != null && Number.isFinite(input.blowerWatts)
        ? input.blowerWatts
        : null
    const energized = blowerW != null && blowerW >= ECM_ENERGIZED_MIN_W
    const overRatedStatic = staticInWc > ECM_MAX_RATED_STATIC_INWC
    const cfmRounded = Math.round(rated)

    // Blower power present but too low to be holding design airflow: we can't
    // confirm the ECM is doing its job, so hold commanded but lower confidence.
    if (blowerW != null && !energized) {
      return {
        cfm: rated,
        confidence: "static_derived",
        ratedCfm: rated,
        staticInWc,
        staticFlag,
        generalizedModel: false,
        note: `ECM blower power is low (${Math.round(blowerW)} W); can't confirm it's holding airflow. Using commanded ~${cfmRounded} CFM.`,
      }
    }

    return {
      cfm: rated,
      confidence: "ecm_commanded",
      ratedCfm: rated,
      staticInWc,
      staticFlag,
      generalizedModel: false,
      note: overRatedStatic
        ? `ECM holding commanded ~${cfmRounded} CFM, but static (${staticInWc.toFixed(2)}" WC) exceeds the typical ECM limit (~${ECM_MAX_RATED_STATIC_INWC}" WC) — airflow may be starting to fall off. Check ductwork/filter.`
        : `ECM holds commanded ~${cfmRounded} CFM across its rated static range (watts rise with static — expected and correct).`,
    }
  }

  // PSC / fixed-speed: generalized curve anchored to design airflow.
  const cfm = generalizedCurveCfm(rated, staticInWc)
  return {
    cfm,
    confidence: "static_derived",
    ratedCfm: rated,
    staticInWc,
    staticFlag,
    generalizedModel: true,
    note:
      staticFlag === "high"
        ? "Generalized blower curve at high static; enter exact model for an OEM table."
        : "Generalized blower curve at measured static; enter exact model for an OEM table.",
  }
}
