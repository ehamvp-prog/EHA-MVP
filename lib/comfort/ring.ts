// ---------------------------------------------------------------------------
// Dual Comfort Ring engine — PURE ASHRAE comfort (100 − PPD), nothing blended.
//
// Both ring numbers come from the SAME pure-comfort helper:
//   - TARGET  = comfortFromConditions(preferredTempF, preferredRh)   — FIXED
//   - REALITY = comfortFromConditions(liveTempF, liveRh)             — moves
//
// This deliberately does NOT call computeHappyNumber (the 60/40 blend). That
// function and all of happy-number.ts stay untouched; we only reuse the raw
// Fanger model (pmvPpd) plus the existing met/clo/vel assumptions.
// ---------------------------------------------------------------------------

import { pmvPpd, fToC, cloForMonth, metForActivity, type ComfortProfile } from "./happy-number"

// Month in Central time (fixed UTC-6) — matches the rest of the app.
export function monthCst(now: number = Date.now()): number {
  return new Date(now - 6 * 60 * 60 * 1000).getUTCMonth()
}

// Pure ASHRAE comfort score (0–100) for a given air temp + humidity. Reuses the
// SAME met/clo/vel assumptions computeHappyNumber uses, so the two stay aligned.
export function comfortDetail(
  tempF: number,
  rh: number,
  profile: Pick<ComfortProfile, "activity_level">,
  month: number,
): { comfort: number; pmv: number; ppd: number } {
  const ta = fToC(tempF)
  const tr = ta // mean radiant temp = air temp (no surface sensors)
  const vel = 0.1 // still air, blower cycling
  const met = metForActivity(profile.activity_level)
  const clo = cloForMonth(month)
  const { pmv, ppd } = pmvPpd(ta, tr, vel, rh, met, clo)
  const comfort = Math.max(0, Math.min(100, Math.round(100 - ppd)))
  return { comfort, pmv, ppd }
}

export function comfortFromConditions(
  tempF: number,
  rh: number,
  profile: Pick<ComfortProfile, "activity_level">,
  month: number,
): number {
  return comfortDetail(tempF, rh, profile, month).comfort
}

// Happy Climate when target and reality are within 5 points.
export const HAPPY_CLIMATE_GAP = 5

export type GapExplanation = {
  gap: number
  withinRange: boolean
  // dominant driver of the discrepancy
  primary: "temperature" | "humidity" | "none"
  tempDeltaF: number // live − target (positive = warmer than ideal)
  rhDelta: number // live − target (positive = more humid than ideal)
  pmv: number // live PMV (sign: >0 too warm, <0 too cool)
  plain: string // plain-English summary of the gap
  // target-aware suggested fix (aim the thermostat toward the learned target)
  suggestedSetpointF: number | null
  fanWouldHelp: boolean
}

// Explain WHY reality diverges from target and WHAT closes it. The score shown
// on the ring is pure comfort, but the suggestion aims toward the learned
// target conditions (not a generic neutral point).
export function explainGap(opts: {
  liveTempF: number
  liveRh: number
  targetTempF: number
  targetRh: number
  profile: Pick<ComfortProfile, "activity_level">
  month: number
}): GapExplanation {
  const { liveTempF, liveRh, targetTempF, targetRh, profile, month } = opts

  const reality = comfortDetail(liveTempF, liveRh, profile, month)
  const target = comfortDetail(targetTempF, targetRh, profile, month)
  const gap = Math.abs(target.comfort - reality.comfort)
  const withinRange = gap <= HAPPY_CLIMATE_GAP

  const tempDeltaF = Math.round((liveTempF - targetTempF) * 10) / 10
  const rhDelta = Math.round(liveRh - targetRh)

  // Decide the dominant driver by counterfactual: how much would comfort
  // improve if we fixed ONLY temperature vs ONLY humidity to the target.
  const fixTemp = comfortFromConditions(targetTempF, liveRh, profile, month)
  const fixRh = comfortFromConditions(liveTempF, targetRh, profile, month)
  const tempGain = fixTemp - reality.comfort
  const rhGain = fixRh - reality.comfort

  let primary: GapExplanation["primary"] = "none"
  if (!withinRange) primary = tempGain >= rhGain ? "temperature" : "humidity"

  // Plain-English description of how reality differs from the ideal.
  const tempWord =
    Math.abs(tempDeltaF) < 0.5 ? "right at your ideal temperature" : tempDeltaF > 0 ? `${Math.abs(Math.round(tempDeltaF))}° warmer` : `${Math.abs(Math.round(tempDeltaF))}° cooler`
  const rhWord =
    Math.abs(rhDelta) < 3
      ? "about as humid as you like"
      : rhDelta > 0
        ? `${Math.abs(rhDelta)}% more humid`
        : `${Math.abs(rhDelta)}% drier`
  const plain = withinRange
    ? "Your home is right in your comfort zone."
    : `Your home is ${tempWord} and ${rhWord} than your ideal.`

  // Target-aware fix: nudge the thermostat toward the learned target temp.
  // Only suggest a setpoint when temperature is the (or a) meaningful driver.
  const suggestedSetpointF =
    withinRange || Math.abs(tempDeltaF) < 0.5 ? null : Math.round(targetTempF)
  // Circulation helps most when humidity dominates and temp is close.
  const fanWouldHelp = !withinRange && primary === "humidity"

  return {
    gap,
    withinRange,
    primary,
    tempDeltaF,
    rhDelta,
    pmv: reality.pmv,
    plain,
    suggestedSetpointF,
    fanWouldHelp,
  }
}

// ---------------------------------------------------------------------------
// Learned comfort target — exponentially weighted average of training captures
// with a ~30-day half-life (weight = 0.5 ^ (ageDays / 30)). Recent captures
// count more, so the target drifts toward current-season comfort without
// swinging on a handful of points.
// ---------------------------------------------------------------------------

export const CAPTURE_HALF_LIFE_DAYS = 30

export type Capture = {
  captured_at: string
  temp_f: number
  rh: number
  source?: "nest" | "sensor"
}

export function learnedTargetFromCaptures(
  captures: Capture[],
  now: number = Date.now(),
): { tempF: number; rh: number } | null {
  if (!captures.length) return null
  let wSum = 0
  let tSum = 0
  let rSum = 0
  for (const cap of captures) {
    const ageDays = (now - new Date(cap.captured_at).getTime()) / 86_400_000
    const w = Math.pow(0.5, Math.max(0, ageDays) / CAPTURE_HALF_LIFE_DAYS)
    wSum += w
    tSum += w * cap.temp_f
    rSum += w * cap.rh
  }
  if (wSum === 0) return null
  return {
    tempF: Math.round((tSum / wSum) * 10) / 10,
    rh: Math.round((rSum / wSum) * 10) / 10,
  }
}

// ---------------------------------------------------------------------------
// Hard temperature clamp — automation may NEVER set below min or above max,
// ever, for any reason. Returns the clamped value plus whether it was clamped
// (so the UI/journal can honestly show it refusing to cross the band).
// ---------------------------------------------------------------------------

export function clampSetpoint(
  desiredF: number,
  minF: number,
  maxF: number,
): { value: number; clamped: boolean; reason: "below_min" | "above_max" | null } {
  if (desiredF < minF) return { value: minF, clamped: true, reason: "below_min" }
  if (desiredF > maxF) return { value: maxF, clamped: true, reason: "above_max" }
  return { value: Math.round(desiredF), clamped: false, reason: null }
}
