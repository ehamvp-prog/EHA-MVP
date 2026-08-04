// ---------------------------------------------------------------------------
// Capture-learning + safety-clamp utilities.
//
// The comfort MATH (band derivation, Happy Number, Comfort Score) now lives in
// lib/comfort/model.ts and is loaded server-side via lib/comfort/load.ts. What
// remains here is model-independent and still shared by the capture route and
// the automation engine:
//   - learnedTargetFromCaptures — weighted average of "felt perfect" captures
//   - clampSetpoint             — the hard temperature safety clamp
// ---------------------------------------------------------------------------

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
