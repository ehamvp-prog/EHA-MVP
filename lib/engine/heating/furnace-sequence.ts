// =====================================================================
// Furnace sequence decoder — reads the FURNACE power trace and names the
// stage the furnace is in right now.
//
// Why this exists: on this site the "blower" Shelly EM channel is clamped
// on the furnace's 120 V feed, so it sees EVERYTHING the furnace does —
// control board, inducer, hot-surface igniter, gas-valve solenoid and the
// blower. That one watt trace carries the whole gas-heat sequence:
//
//   idle (board only, ~2 W)
//     → call for heat: INDUCER spins up (+60–150 W)            = prepurge
//     → pressure switch proves, HSI energizes (+300–500 W)     = ignition
//     → gas valve opens, HSI drops out, flame proves
//     → ~30–60 s later the BLOWER starts at heat speed          = burn
//     → call satisfied: gas off, inducer post-purges (~15 s),
//       blower keeps running 60–180 s to cool the exchanger     = post_purge
//     → everything drops back to board-only                     = idle
//
// Two-stage furnaces run the inducer at two speeds, so steady BURN watts
// differ by stage. The exact numbers are site-specific and come from
// commissioning (installer captures low/high fire watts while clocking
// the gas meter). Until commissioned, the decoder falls back to generic
// bands and reports confidence = "uncommissioned".
//
// The decoder is a PURE step function: feed it the previous stage and the
// new sample, get the new stage. It works on any cadence, but:
//   - 5 s telemetry  → every stage is visible, incl. the 20–40 s HSI spike
//   - 60 s minutes   → ignition is averaged away; burn/idle/fan are reliable
// =====================================================================

export type FurnaceStage =
  | "idle" // control board only
  | "fan_only" // blower running, no burner, no residual heat
  | "prepurge" // inducer running, blower off, before ignition
  | "ignition" // inducer + hot-surface igniter
  | "burn" // gas valve open, blower at heat speed
  | "post_purge" // gas off, blower still running the exchanger down
  | "cooling_blower" // condenser is on — this is the AC's blower, not heat
  | "unknown"

export type FireStage = "low" | "high" | "single" | "unknown"

export interface FurnaceSignature {
  // All values in watts on the furnace EM channel.
  idle_max_w: number // ≤ this = board only
  fan_only_w: number // blower alone at fan/continuous speed
  inducer_only_w: number // inducer alone (blower off)
  ignition_min_w: number // inducer + HSI: anything at/above this is ignition
  burn_low_w: number | null // steady burn, low fire (inducer lo + blower heat tap)
  burn_high_w: number | null // steady burn, high fire
  burn_single_w: number | null // single-stage furnaces
  cooling_blower_w: number | null // blower at cooling tap (so we can tell it apart)
  tolerance_pct: number // band half-width as a fraction of the band center
  commissioned: boolean
}

// Generic starting bands. These are NOT this site's numbers — commissioning
// replaces them. They exist so the decoder still says something useful
// (idle / fan / ignition / burn) before the installer captures real values.
export const DEFAULT_FURNACE_SIGNATURE: FurnaceSignature = {
  idle_max_w: 15,
  fan_only_w: 80,
  inducer_only_w: 90,
  ignition_min_w: 350,
  burn_low_w: null,
  burn_high_w: null,
  burn_single_w: 220,
  cooling_blower_w: null,
  tolerance_pct: 0.2,
  commissioned: false,
}

export interface FurnaceSample {
  furnaceWatts: number | null
  condenserWatts: number | null
  // supply − return. Positive while heating. Optional but it makes
  // post-purge vs fan-only unambiguous.
  riseF: number | null
}

export interface FurnaceStepResult {
  stage: FurnaceStage
  fire: FireStage
  burnerOn: boolean // gas valve open (counts toward gas input)
  blowerOn: boolean // air is moving (counts toward delivered heat)
  confidence: "commissioned" | "uncommissioned" | "none"
  note: string
}

// A supply−return rise at or above this says real heat is in the duct.
const RISE_HEAT_MIN_F = 8
// Below this, any blower-only running is just circulation.
const RISE_RESIDUAL_MIN_F = 3

function within(w: number, center: number, tolPct: number): boolean {
  const half = Math.max(center * tolPct, 10)
  return w >= center - half && w <= center + half
}

function nearestFire(w: number, sig: FurnaceSignature): FireStage {
  const cands: { fire: FireStage; w: number }[] = []
  if (sig.burn_low_w != null) cands.push({ fire: "low", w: sig.burn_low_w })
  if (sig.burn_high_w != null) cands.push({ fire: "high", w: sig.burn_high_w })
  if (sig.burn_single_w != null) cands.push({ fire: "single", w: sig.burn_single_w })
  if (!cands.length) return "unknown"
  cands.sort((a, b) => Math.abs(a.w - w) - Math.abs(b.w - w))
  return within(w, cands[0].w, sig.tolerance_pct) ? cands[0].fire : "unknown"
}

/**
 * One decoding step. `prev` is the stage from the previous sample (or null
 * on the first one). Pure — no clocks, no I/O.
 */
export function decodeFurnaceStep(
  prev: FurnaceStage | null,
  sample: FurnaceSample,
  sig: FurnaceSignature = DEFAULT_FURNACE_SIGNATURE,
): FurnaceStepResult {
  const w = sample.furnaceWatts
  const conf = sig.commissioned ? "commissioned" : "uncommissioned"

  if (w == null || !Number.isFinite(w)) {
    return { stage: "unknown", fire: "unknown", burnerOn: false, blowerOn: false, confidence: "none", note: "No furnace power reading." }
  }

  // The condenser decides first: if it is pulling real power, the blower on
  // the furnace channel is the AC's blower. Not a heat stage.
  if (sample.condenserWatts != null && sample.condenserWatts >= 100) {
    return { stage: "cooling_blower", fire: "unknown", burnerOn: false, blowerOn: w > sig.idle_max_w, confidence: conf, note: "Condenser running — blower is serving the AC." }
  }

  const rise = sample.riseF
  const heatInDuct = rise != null && rise >= RISE_HEAT_MIN_F
  const residualHeat = rise != null && rise >= RISE_RESIDUAL_MIN_F

  // 1. Idle: board only.
  if (w <= sig.idle_max_w) {
    return { stage: "idle", fire: "unknown", burnerOn: false, blowerOn: false, confidence: conf, note: "Furnace idle." }
  }

  // 2. Ignition: the HSI spike is the single biggest draw in the sequence.
  if (w >= sig.ignition_min_w) {
    return { stage: "ignition", fire: "unknown", burnerOn: false, blowerOn: false, confidence: conf, note: "Igniter energized — trial for ignition." }
  }

  // 3. Blower-alone band (fan speed). Heat in the duct with no burner means
  //    the exchanger is being run down after a cycle.
  if (within(w, sig.fan_only_w, sig.tolerance_pct)) {
    if (residualHeat && (prev === "burn" || prev === "post_purge" || prev === "ignition")) {
      return { stage: "post_purge", fire: "unknown", burnerOn: false, blowerOn: true, confidence: conf, note: "Gas off, blower running the exchanger down." }
    }
    return { stage: "fan_only", fire: "unknown", burnerOn: false, blowerOn: true, confidence: conf, note: "Blower circulating, no burner." }
  }

  // 4. Burn bands (inducer + blower at heat tap). Commissioned low/high
  //    bands give a fire stage; otherwise nearest generic band or unknown.
  const fire = nearestFire(w, sig)
  if (fire !== "unknown") {
    // A burn band without heat in the duct for a while is suspicious, but
    // the first 60 s after the valve opens legitimately look like this.
    return { stage: "burn", fire, burnerOn: true, blowerOn: true, confidence: conf, note: heatInDuct ? `Burning (${fire} fire).` : `Burn-band power, heat not yet at the supply sensor.` }
  }

  // 5. Inducer alone: before ignition it's prepurge; after a burn it's the
  //    short post-purge before the blower stops.
  if (within(w, sig.inducer_only_w, sig.tolerance_pct)) {
    if (prev === "burn" || prev === "post_purge") {
      return { stage: "post_purge", fire: "unknown", burnerOn: false, blowerOn: false, confidence: conf, note: "Inducer post-purge." }
    }
    return { stage: "prepurge", fire: "unknown", burnerOn: false, blowerOn: false, confidence: conf, note: "Inducer prepurge — call for heat received." }
  }

  // 6. Nothing matched. Say so rather than guess; the rise can still tell us
  //    whether heat is being delivered.
  return {
    stage: "unknown",
    fire: "unknown",
    burnerOn: false,
    blowerOn: w > sig.fan_only_w * 0.5,
    confidence: conf,
    note: heatInDuct
      ? `Unrecognized ${Math.round(w)} W on the furnace channel while heat is in the duct — commission the furnace signature.`
      : `Unrecognized ${Math.round(w)} W on the furnace channel.`,
  }
}

// ---------------------------------------------------------------------
// Cycle folding — turn a stage timeline into heat cycles.
// ---------------------------------------------------------------------

export interface StageSample {
  at: string // ISO timestamp
  stage: FurnaceStage
  fire: FireStage
  seconds: number // how long this sample represents (5 s telemetry, 60 s minutes)
}

export interface HeatCycle {
  start: string // first ignition/prepurge/burn sample
  end: string // last post_purge (or burn) sample
  burn_seconds: number
  low_fire_seconds: number
  high_fire_seconds: number
  post_purge_seconds: number
  ignitions: number
  short_cycle: boolean // burn < SHORT_CYCLE_MIN_S
}

// A burn shorter than this is a short cycle (limit trips, oversizing,
// a dirty filter choking airflow). Five minutes is the usual field rule.
export const SHORT_CYCLE_MIN_S = 5 * 60

const CALL_STAGES: FurnaceStage[] = ["prepurge", "ignition", "burn", "post_purge"]

export function foldHeatCycles(samples: StageSample[]): HeatCycle[] {
  const cycles: HeatCycle[] = []
  let cur: HeatCycle | null = null
  let lastWasIgnition = false

  for (const s of samples) {
    const inCall = CALL_STAGES.includes(s.stage)
    if (inCall && !cur) {
      cur = { start: s.at, end: s.at, burn_seconds: 0, low_fire_seconds: 0, high_fire_seconds: 0, post_purge_seconds: 0, ignitions: 0, short_cycle: false }
    }
    if (!cur) continue
    if (inCall) {
      cur.end = s.at
      if (s.stage === "ignition" && !lastWasIgnition) cur.ignitions++
      if (s.stage === "burn") {
        cur.burn_seconds += s.seconds
        if (s.fire === "low") cur.low_fire_seconds += s.seconds
        if (s.fire === "high") cur.high_fire_seconds += s.seconds
      }
      if (s.stage === "post_purge") cur.post_purge_seconds += s.seconds
      lastWasIgnition = s.stage === "ignition"
    } else {
      cur.short_cycle = cur.burn_seconds > 0 && cur.burn_seconds < SHORT_CYCLE_MIN_S
      cycles.push(cur)
      cur = null
      lastWasIgnition = false
    }
  }
  if (cur) {
    cur.short_cycle = cur.burn_seconds > 0 && cur.burn_seconds < SHORT_CYCLE_MIN_S
    cycles.push(cur)
  }
  return cycles
}
