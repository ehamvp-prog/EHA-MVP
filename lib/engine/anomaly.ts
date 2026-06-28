// =====================================================================
// Anomaly Color Layer
//
// Turns the live efficiency reading into a single status color by
// comparing it against a ROLLING HEALTHY BASELINE that is conditioned on
// OUTDOOR TEMPERATURE (a system's healthy EER at 95F looks very different
// from its healthy EER at 70F, so we only compare like-for-like).
//
// Two hard requirements from the spec drive the design:
//   1. Outdoor-temperature conditioning: only compare a reading to past
//      readings taken at a similar outdoor temperature.
//   2. Weather-confidence weighting: when the outdoor data is stale or
//      uncertain, widen the bands AND cap the severity so we never raise
//      a loud (red) alarm on shaky evidence.
//
// The engine NEVER fabricates a verdict. When the system is idle, when EER
// can't be computed, or when there isn't enough history yet, it returns an
// honest non-judgmental state instead of a green/red guess.
// =====================================================================

export type EfficiencyColor =
  | "green" // performing at/near healthy baseline
  | "yellow" // mild drop
  | "orange" // notable drop
  | "red" // severe drop
  | "idle" // system not actively cooling — nothing to judge
  | "learning" // not enough baseline history at this outdoor temp yet
  | "unknown" // running, but EER can't be computed (e.g. airflow fallback)

export interface BaselineSample {
  outdoorTempF: number | null
  liveEer: number | null
}

export type WeatherConfidence = "high" | "medium" | "low" | null

export interface AnomalyInput {
  liveEer: number | null
  totalWatts: number | null
  // Corroborated running state (condenser power OR blower OR delta-T). When
  // provided it overrides the simple watts gate below, so a single missed
  // power reading can no longer force a false "idle"/"off" verdict.
  systemRunning?: boolean
  outdoorTempF: number | null
  weatherConfidence: WeatherConfidence
  baseline: BaselineSample[]
}

export interface AnomalyResult {
  color: EfficiencyColor
  deviationPct: number | null // fractional drop below the healthy reference (0 = at/above)
  baselineEer: number | null // the healthy reference EER for this outdoor temp
  baselineSampleCount: number // how many past readings informed the baseline
  capped: boolean // true if low confidence prevented a more severe color
  note: string
}

// --- Tunable constants (documented; safe defaults) -------------------

// Outdoor-temp bin half-width: a reading is compared only to history within
// +/- this many degrees F of the current outdoor temperature.
const TEMP_BIN_F = 5

// Minimum number of in-bin samples before we trust a baseline. Below this we
// stay in "learning" rather than risk a false verdict.
const MIN_SAMPLES = 12

// The "healthy reference" is an upper percentile of in-bin EER, so we measure
// drop from good performance rather than from the middle of the pack.
const HEALTHY_PERCENTILE = 0.75

// Base fractional-drop thresholds at HIGH weather confidence.
const BASE_THRESHOLDS = { green: 0.08, yellow: 0.15, orange: 0.25 }

// Band-widening multipliers by weather confidence. Lower confidence => wider
// bands (harder to trip) so uncertain outdoor data doesn't cause false alarms.
const CONFIDENCE_WIDEN: Record<"high" | "medium" | "low", number> = {
  high: 1.0,
  medium: 1.3,
  low: 1.7,
}

// A running system drawing at least this many watts is "actively cooling".
const RUNNING_WATTS_MIN = 200

// --- helpers ---------------------------------------------------------

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN
  if (sortedAsc.length === 1) return sortedAsc[0]
  const idx = p * (sortedAsc.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sortedAsc[lo]
  const frac = idx - lo
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac
}

// --- main ------------------------------------------------------------

export function assessAnomaly(input: AnomalyInput): AnomalyResult {
  const { liveEer, totalWatts, outdoorTempF, weatherConfidence, baseline } = input

  const base = (n: number) => ({
    color: "idle" as EfficiencyColor,
    deviationPct: null as number | null,
    baselineEer: null as number | null,
    baselineSampleCount: n,
    capped: false,
    note: "",
  })

  // 1. Is the system actually cooling? Prefer the corroborated multi-signal
  //    running state; fall back to the watts gate only if it wasn't supplied.
  const running =
    input.systemRunning ?? (totalWatts != null && totalWatts >= RUNNING_WATTS_MIN)
  if (!running) {
    return { ...base(0), color: "idle", note: "System is not actively cooling." }
  }

  // 2. Running, but we couldn't compute EER (e.g. no supply-air sensor, or
  //    airflow fell back). Be honest: unknown, not a color verdict.
  if (liveEer == null) {
    return {
      ...base(0),
      color: "unknown",
      note: "System is running, but efficiency can't be measured right now.",
    }
  }

  // 3. Build the outdoor-temperature-conditioned baseline.
  let inBin: number[]
  let conditioned = true
  if (outdoorTempF == null) {
    // No outdoor temp: we can't condition. Use all valid history but force
    // low confidence so the verdict is conservative.
    conditioned = false
    inBin = baseline.map((s) => s.liveEer).filter((e): e is number => e != null && e > 0)
  } else {
    inBin = baseline
      .filter(
        (s) =>
          s.outdoorTempF != null &&
          s.liveEer != null &&
          s.liveEer > 0 &&
          Math.abs(s.outdoorTempF - outdoorTempF) <= TEMP_BIN_F,
      )
      .map((s) => s.liveEer as number)
  }

  if (inBin.length < MIN_SAMPLES) {
    return {
      ...base(inBin.length),
      color: "learning",
      note: `Building a healthy baseline (${inBin.length}/${MIN_SAMPLES} comparable readings near ${
        outdoorTempF != null ? `${Math.round(outdoorTempF)}F` : "this condition"
      }).`,
    }
  }

  // 4. Healthy reference = upper percentile of in-bin EER.
  const sorted = [...inBin].sort((a, b) => a - b)
  const baselineEer = percentile(sorted, HEALTHY_PERCENTILE)

  // 5. Deviation = fractional drop below the healthy reference (clamp at 0).
  const rawDev = (baselineEer - liveEer) / baselineEer
  const deviationPct = Math.max(0, rawDev)

  // 6. Widen thresholds by weather confidence (and force low if unconditioned).
  const effConfidence: "high" | "medium" | "low" =
    !conditioned ? "low" : (weatherConfidence ?? "medium")
  const widen = CONFIDENCE_WIDEN[effConfidence]
  const t = {
    green: BASE_THRESHOLDS.green * widen,
    yellow: BASE_THRESHOLDS.yellow * widen,
    orange: BASE_THRESHOLDS.orange * widen,
  }

  // 7. Map deviation -> color.
  let color: EfficiencyColor
  if (deviationPct < t.green) color = "green"
  else if (deviationPct < t.yellow) color = "yellow"
  else if (deviationPct < t.orange) color = "orange"
  else color = "red"

  // 8. Low-confidence severity cap: never raise the loudest alarm on shaky
  //    outdoor evidence. Red is held back to orange.
  let capped = false
  if (effConfidence === "low" && color === "red") {
    color = "orange"
    capped = true
  }

  const pctText = `${(deviationPct * 100).toFixed(1)}% below healthy`
  const note =
    color === "green"
      ? `Performing at healthy baseline for ${Math.round(outdoorTempF ?? 0)}F (${pctText}).`
      : `${pctText} baseline at ${
          outdoorTempF != null ? `${Math.round(outdoorTempF)}F` : "current conditions"
        }${capped ? "; severity capped (low weather confidence)" : ""}.`

  return {
    color,
    deviationPct,
    baselineEer: Math.round(baselineEer * 100) / 100,
    baselineSampleCount: inBin.length,
    capped,
    note,
  }
}
