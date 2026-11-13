// =====================================================================
// Heat / cool targets and the humidity check.
//
// The household sets a HEAT number and a COOL number (day and sleep). In
// Auto (Nest HEATCOOL) the Nest switches between them on its own; the two
// always stay at least MIN_BAND_F apart so the system never fights itself.
// Heat mode uses the heat number, Cool mode the cool number.
// =====================================================================

export const MIN_BAND_F = 2

export type ModeTargets = { heat: number; cool: number }

type ProfileLike = Record<string, unknown> | null | undefined

const n = (v: unknown): number | null => (v == null || !Number.isFinite(Number(v)) ? null : Number(v))

// Day or sleep pair. Falls back to the old single-target fields for profiles
// saved before heat/cool were split, then forces the 2°F gap.
export function modeTargets(p: ProfileLike, inSleep: boolean): ModeTargets {
  const preferred = n(p?.preferred_temp_f) ?? 72
  const sleep = n(p?.sleep_target_f) ?? preferred
  const heat = inSleep ? (n(p?.sleep_heat_target_f) ?? sleep) : (n(p?.heat_target_f) ?? preferred)
  const coolRaw = inSleep ? (n(p?.sleep_cool_target_f) ?? sleep + MIN_BAND_F) : (n(p?.cool_target_f) ?? preferred + MIN_BAND_F)
  return { heat, cool: Math.max(coolRaw, heat + MIN_BAND_F) }
}

// Dew point (°F) from temperature (°F) and relative humidity (%), Magnus formula.
export function dewPointF(tempF: number, rh: number): number | null {
  if (!Number.isFinite(tempF) || !Number.isFinite(rh) || rh <= 0) return null
  const tc = ((tempF - 32) * 5) / 9
  const a = 17.62
  const b = 243.12
  const g = Math.log(Math.min(rh, 100) / 100) + (a * tc) / (b + tc)
  const dc = (b * g) / (a - g)
  return Math.round(((dc * 9) / 5 + 32) * 10) / 10
}

export type DryingCheck = {
  allowed: boolean
  reason: string
  indoor_dew_f: number | null
  outdoor_dew_f: number | null
  outdoor_temp_f: number | null
}

// May the AC run extra (overcool) just to pull humidity down?
// Only when BOTH are true:
//   1. It's warmer outside than the cool target — there's a real cooling need,
//      so the extra run time isn't just chilling the house.
//   2. Outside air is at least as wet as inside (outdoor dew point >= indoor).
//      If outside is drier, the moisture is coming from inside the house
//      (cooking, showers, people) and fresh air would fix it without making
//      anyone cold.
// No outdoor reading = don't overcool (never guess toward making people cold).
export function acDryingCheck(input: {
  indoorTempF: number
  indoorRh: number
  outdoorTempF: number | null
  outdoorRh: number | null
  coolTargetF: number
}): DryingCheck {
  const indoorDew = dewPointF(input.indoorTempF, input.indoorRh)
  const outdoorDew =
    input.outdoorTempF != null && input.outdoorRh != null ? dewPointF(input.outdoorTempF, input.outdoorRh) : null
  const base = { indoor_dew_f: indoorDew, outdoor_dew_f: outdoorDew, outdoor_temp_f: input.outdoorTempF }
  if (input.outdoorTempF == null || outdoorDew == null || indoorDew == null) {
    return { allowed: false, reason: "no outdoor reading", ...base }
  }
  if (input.outdoorTempF < input.coolTargetF) {
    return {
      allowed: false,
      reason: `${Math.round(input.outdoorTempF)}°F outside is cooler than your ${Math.round(input.coolTargetF)}°F cool target — running the AC just to dry the air would make the house cold`,
      ...base,
    }
  }
  if (outdoorDew < indoorDew) {
    return {
      allowed: false,
      reason: `outside air is drier than inside (dew point ${Math.round(outdoorDew)}°F out vs ${Math.round(indoorDew)}°F in) — fresh air would bring humidity down without cooling`,
      ...base,
    }
  }
  return { allowed: true, reason: "warm and humid outside", ...base }
}
