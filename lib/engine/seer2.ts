// =====================================================================
// Live EER and the Measured SEER2 Estimate.
//
// Live EER = cooling capacity (BTU/hr) / total electrical power (W).
//
// "Measured SEER2 Estimate" is NOT a lab certificate. It expresses live
// field performance on a SEER2-equivalent basis using an equipment-
// class-aware, tunable conversion factor:
//
//   measured_seer2_estimate = live_eer * conversion_factor
//
// The factor defaults by equipment class but can be overridden per home
// via system_profile.seer2_conversion_factor. Rated SEER2 (nameplate) is
// only an outer sanity bound, never the source of the live number.
// =====================================================================

// Equipment-class default conversion factors (tunable starting points).
// 0.95 baseline for standard split systems per the MVP spec.
const CLASS_FACTORS: Record<string, number> = {
  standard_split: 0.95,
  two_stage_split: 1.0,
  variable_speed_inverter: 1.1,
  packaged_unit: 0.9,
  heat_pump: 0.95,
}

const DEFAULT_FACTOR = 0.95

export function seer2ConversionFactor(
  equipmentClass: string | null | undefined,
  override: number | null | undefined,
): { factor: number; source: string } {
  if (override != null && Number.isFinite(override) && override > 0) {
    return { factor: override, source: "profile override" }
  }
  if (equipmentClass && CLASS_FACTORS[equipmentClass] != null) {
    return { factor: CLASS_FACTORS[equipmentClass], source: `class default (${equipmentClass})` }
  }
  return { factor: DEFAULT_FACTOR, source: "default baseline" }
}

export interface EfficiencyResult {
  totalWatts: number | null
  liveEer: number | null
  measuredSeer2Estimate: number | null
  seer2FactorUsed: number
  seer2FactorSource: string
}

export function computeEfficiency(
  capacityBtuh: number | null,
  totalWatts: number | null,
  equipmentClass: string | null | undefined,
  factorOverride: number | null | undefined,
): EfficiencyResult {
  const { factor, source } = seer2ConversionFactor(equipmentClass, factorOverride)

  if (
    capacityBtuh == null ||
    totalWatts == null ||
    !Number.isFinite(capacityBtuh) ||
    !Number.isFinite(totalWatts) ||
    totalWatts <= 0
  ) {
    return {
      totalWatts: totalWatts ?? null,
      liveEer: null,
      measuredSeer2Estimate: null,
      seer2FactorUsed: factor,
      seer2FactorSource: source,
    }
  }

  const eer = capacityBtuh / totalWatts
  const seer2 = eer * factor

  return {
    totalWatts,
    liveEer: eer,
    measuredSeer2Estimate: seer2,
    seer2FactorUsed: factor,
    seer2FactorSource: source,
  }
}
