// =====================================================================
// Airflow (CFM) derivation — STATIC PRESSURE + BLOWER PROFILE ONLY.
//
// This stack has NO refrigerant-side probes, ever. So there is no
// independent air-side airflow solution. The two confidence states are:
//
//   "static_derived" : we have a static pressure reading AND a usable
//                       blower characterization. Airflow is trusted.
//   "fallback"       : blower profile is insufficient (or static is
//                       missing). Airflow is UNKNOWN -> returned null,
//                       and downstream capacity/EER/SEER2 stay blank.
//
// The nominal tonnage-based CFM (tonnage * cfm_per_ton) is kept ONLY as
// an outer-bounds reference. It is NEVER used to fabricate a displayed
// capacity. (Per the locked decision: "show airflow as unknown, leave
// capacity blank" when the blower profile isn't filled in.)
// =====================================================================

export type AirflowConfidence = "static_derived" | "fallback"

export interface AirflowResult {
  cfm: number | null // usable airflow for capacity; null when fallback
  confidence: AirflowConfidence
  ratedCfm: number | null // tonnage * cfm_per_ton, outer-bounds reference only
  staticInWc: number | null
  staticFlag: "normal" | "high" | "unknown" // sanity vs blower
  note: string
}

// A reasonable upper bound for total external static on residential
// equipment. Above this, even an ECM is likely out of its control band.
const HIGH_STATIC_INWC = 0.8

interface AirflowInputs {
  staticInWc: number | null | undefined
  tonnage: number | null | undefined
  cfmPerTon: number | null | undefined
  blowerType: string | null | undefined // 'furnace' | 'air_handler'
  ecmProfile: string | null | undefined // presence implies ECM/variable
  blowerSpeedTap: string | null | undefined
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

export function deriveAirflow(input: AirflowInputs): AirflowResult {
  const rated = ratedCfmOf(input.tonnage, input.cfmPerTon)
  const staticInWc =
    input.staticInWc != null && Number.isFinite(input.staticInWc)
      ? input.staticInWc
      : null

  // No static reading -> we cannot trust airflow. Fallback.
  if (staticInWc == null) {
    return {
      cfm: null,
      confidence: "fallback",
      ratedCfm: rated,
      staticInWc: null,
      staticFlag: "unknown",
      note: "No static pressure reading. Airflow unknown; capacity left blank.",
    }
  }

  const staticFlag: AirflowResult["staticFlag"] =
    staticInWc > HIGH_STATIC_INWC ? "high" : "normal"

  // ECM / variable-speed: blower targets the commanded (design) airflow.
  // Static is the sanity cross-check. This is the trusted path.
  if (isEcm(input.ecmProfile) && rated != null) {
    return {
      cfm: rated,
      confidence: "static_derived",
      ratedCfm: rated,
      staticInWc,
      staticFlag,
      note:
        staticFlag === "high"
          ? "ECM commanded airflow; static is high, real CFM may be reduced."
          : "ECM commanded airflow, static within normal range.",
    }
  }

  // PSC / fixed-speed without an OEM blower table: no reliable static->CFM
  // map yet. Honest answer is fallback until blower-table data exists.
  return {
    cfm: null,
    confidence: "fallback",
    ratedCfm: rated,
    staticInWc,
    staticFlag,
    note: "Fixed-speed blower without a blower table; cannot derive CFM from static yet. Airflow unknown; capacity left blank.",
  }
}
