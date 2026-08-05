// ---------------------------------------------------------------------------
// Elevate Comfort Model — ONE function drives both the Happy Number and the
// Comfort Score. ASHRAE Standard 55 PMV/PPD via a maintained library
// (jsthermalcomfort), fed all six inputs. The household's acceptable envelope
// is swept from the PMV model, then narrowed by the household constraints that
// the database resolves for us (comfort_model_inputs / comfort_band_constraints
// RPCs). We NEVER re-derive constraints here — the DB is the source of truth.
//
//   Happy Number  = 0.60*width_component + 0.40*centrality(preferred)  (spec §3.1)
//   Comfort Score = happy + (100-happy)*(c_live-c_pref)/max(1,100-c_pref)  (§3.2 v2.4)
//
// The Happy Number is Elevate's OWN metric, not raw ASHRAE. It measures how
// SPECIFIC the household's climate is: width_component from how much of the PMV
// envelope survives the household's health constraints, centrality from how far
// the household's PREFERRED conditions sit from a typical climate (73°F/45%).
// 1 = a highly specific climate, 100 = a typical one. Every profile qualifier
// (asthma, allergies, occupants, activity) narrows the band and lowers it.
//
// The Comfort Score lives on that SAME typical-anchored scale (v2.4 §3.2): it
// reads the Happy Number when the home is exactly at the household's preference
// and rises toward 100 as conditions approach typical — but also falls below the
// Happy Number, to 1, when conditions drift even further from typical than the
// preference. So it is NOT "higher is better": the home is on target when the
// Comfort Score EQUALS the Happy Number, and the app judges comfort by the
// CLOSENESS of the two numbers, never by the score's height. This replaced an
// earlier preferred-anchored, min()-capped curve that saturated at 100 for
// everything at or past typical distance (77°F, 74°F and 90°F all read 100).
// ---------------------------------------------------------------------------

import { pmvPpdAshrae } from "./pmv"

export const fToC = (f: number) => ((f - 32) * 5) / 9

// PPD at or below this counts as thermally acceptable (ASHRAE 55 Class II-ish).
const PPD_ACCEPTABLE = 20

// Sweep grid for the envelope (°F 1-step, %RH 2-step) per the spec.
const T_LO = 60
const T_HI = 85
const T_STEP = 1
const RH_LO = 20
const RH_HI = 70
const RH_STEP = 2

// Typical-climate reference point + normalization scales for the Happy Number's
// centrality term and the Comfort Score's radial curve (spec v2.3 §3.1/§3.2).
const REF_T = 73
const REF_RH = 45
const T_SCALE = 12
const RH_SCALE = 25

// Normalized radial distance in (°F, %RH) space from the typical reference.
const radial = (dTemp: number, dRh: number) =>
  Math.sqrt((dTemp / T_SCALE) ** 2 + (dRh / RH_SCALE) ** 2)

// Centrality: 100 at the typical climate (73°F/45%), falling to 0 as conditions
// grow more specific. This is the ONE scale both numbers live on — the Happy
// Number's centrality term and the Comfort Score are both measured with it, so
// "1 = highly specific, 100 = typical" means the same thing for both.
const centrality = (t: number, rh: number) => 100 * Math.max(0, 1 - radial(t - REF_T, rh - REF_RH))

export type ConstraintApplies = "baseline" | "night_overlay_2200_0600"

export type Constraint = {
  constraint_name: string
  trigger_source: string
  applies: ConstraintApplies
  min_temp_f: number | null
  max_temp_f: number | null
  min_rh: number | null
  max_rh: number | null
}

// The blob returned by the comfort_model_inputs(site_id) RPC.
export type ModelInputs = {
  met_base: number
  met_adjust: number
  tolerance: number
  occupants: string[]
  health_considerations: string[]
  preferred_temp_f: number
  preferred_rh: number
  activity_level: string
  household_size: number
  constraints: Constraint[]
}

export type ComfortContext = {
  month: number // 0-11, Central time — drives clothing insulation
  blower_on: boolean // drives indoor air speed
  night?: boolean // 22:00-06:00 → fold in the sleep overlay for the hunting band
}

export type ComfortFactor = {
  code: string
  label: string
  severity: "good" | "binding" | "conflict"
}

export type ComfortBand = {
  happyNumber: number
  bandPoints: number
  envelopePoints: number
  tLo: number
  tHi: number
  rhLo: number
  rhHi: number
  empty: boolean // constraints were irreconcilable → relaxation kicked in
  dropped: Constraint[] // constraints relaxed to recover a non-empty band
  active: Constraint[] // constraints actually enforced in this band
  tolerance: number
  points: { t: number; rh: number }[] // acceptable grid points (for the slice)
}

export type ElevateResult = {
  score: number
  happyNumber: number
  band: ComfortBand
  factors: ComfortFactor[]
}

// Sensible fallback when no profile exists yet (median healthy 2-person home).
export const DEFAULT_MODEL_INPUTS: ModelInputs = {
  met_base: 1.3,
  met_adjust: 0,
  tolerance: 1.0,
  occupants: ["adults"],
  health_considerations: [],
  preferred_temp_f: 72,
  preferred_rh: 45,
  activity_level: "moderate",
  household_size: 2,
  constraints: [],
}

// Clothing insulation by season (spec §2). month0: 0=Jan … 11=Dec.
export function cloForMonth(month0: number): number {
  if (month0 >= 5 && month0 <= 8) return 0.5 // Jun–Sep
  if (month0 === 3 || month0 === 4 || month0 === 9) return 0.7 // Apr–May, Oct
  return 1.0 // Nov–Mar
}

const metOf = (i: ModelInputs) => i.met_base + i.met_adjust
const velOf = (ctx: ComfortContext) => (ctx.blower_on ? 0.15 : 0.1)

// PPD (%) for a condition point, feeding ASHRAE all six inputs. Out-of-range
// returns treated as fully unacceptable.
function ppdAt(tempF: number, rh: number, inputs: ModelInputs, ctx: ComfortContext): number {
  const ta = fToC(tempF)
  const r = pmvPpdAshrae(ta, ta, velOf(ctx), rh, metOf(inputs), cloForMonth(ctx.month), 0, {
    units: "SI",
  })
  const ppd = typeof r?.ppd === "number" ? r.ppd : Number(r?.ppd)
  return Number.isFinite(ppd) ? ppd : 100
}

// Comfort Score (spec v2.4 §3.2) — anchored at the TYPICAL climate, on the same
// scale as the Happy Number. It reads the Happy Number when the home is exactly
// at the household's preference and rises to 100 as conditions approach typical
// (73°F/45%). Crucially it can also fall BELOW the Happy Number and clamp to 1
// when the home drifts further from typical than the preference already sits —
// so it resolves ABOVE target and distinguishes too-hot from too-cold, which
// the old preferred-anchored, min()-capped curve could not (everything at or
// past typical distance saturated at 100).
//
//   c_pref = centrality(preferred)          // how specific the household's climate is
//   c_live = centrality(live)               // how specific conditions are right now
//   comfort = happy + (100 - happy) * (c_live - c_pref) / max(1, 100 - c_pref)
//
// At preference c_live == c_pref → comfort == happy. At typical c_live == 100 →
// comfort == 100. max(1, …) guards the household whose preference IS typical.
// Pure geometry — no PMV, no band, no centroid; PMV/PPD only sweeps and explains
// the band, never produces this number.
export function comfortScoreCurve(
  liveTempF: number,
  liveRh: number,
  happyNumber: number,
  prefTempF: number,
  prefRh: number,
): number {
  const cPref = centrality(prefTempF, prefRh)
  const cLive = centrality(liveTempF, liveRh)
  const raw = happyNumber + ((100 - happyNumber) * (cLive - cPref)) / Math.max(1, 100 - cPref)
  return Math.max(1, Math.min(100, Math.round(raw)))
}

// A constraint REMOVES points in a region; a point "passes" if it's not removed.
function passesConstraint(tempF: number, rh: number, c: Constraint): boolean {
  if (c.min_temp_f != null && tempF < c.min_temp_f) return false
  if (c.max_temp_f != null && tempF > c.max_temp_f) return false
  if (c.min_rh != null && rh < c.min_rh) return false
  if (c.max_rh != null && rh > c.max_rh) return false
  return true
}

// Coerce a raw RPC constraint row (which may arrive with string numerics) into
// a typed Constraint.
export function coerceConstraint(raw: Record<string, unknown>): Constraint {
  const n = (v: unknown): number | null => (v == null || v === "" ? null : Number(v))
  const applies = raw.applies === "night_overlay_2200_0600" ? "night_overlay_2200_0600" : "baseline"
  return {
    constraint_name: String(raw.constraint_name ?? "unknown"),
    trigger_source: String(raw.trigger_source ?? ""),
    applies,
    min_temp_f: n(raw.min_temp_f),
    max_temp_f: n(raw.max_temp_f),
    min_rh: n(raw.min_rh),
    max_rh: n(raw.max_rh),
  }
}

// Relaxation priority — DROP FIRST has the lowest number (least medically
// grounded). The respiratory humidity floor has the strongest health basis, so
// it is dropped last. Night sleep preference is dropped before anything medical.
const RELAX_PRIORITY: Record<string, number> = {
  sleep_night_window: -1,
  child_activity_ceiling: 0,
  senior_thermal_floor: 1,
  asthma_humidity_ceiling: 2,
  respiratory_humidity_ceiling: 2,
  allergen_humidity_ceiling: 3,
  respiratory_humidity_floor: 4,
}
const relaxRank = (name: string) => (name in RELAX_PRIORITY ? RELAX_PRIORITY[name] : 2)

type Sweep = {
  band: number
  envelope: number
  tSum: number
  rSum: number
  tLo: number
  tHi: number
  rhLo: number
  rhHi: number
  points: { t: number; rh: number }[]
}

function sweep(inputs: ModelInputs, ctx: ComfortContext, constraints: Constraint[]): Sweep {
  let band = 0
  let envelope = 0
  let tSum = 0
  let rSum = 0
  let tLo = Infinity
  let tHi = -Infinity
  let rhLo = Infinity
  let rhHi = -Infinity
  const points: { t: number; rh: number }[] = []

  for (let t = T_LO; t <= T_HI; t += T_STEP) {
    for (let rh = RH_LO; rh <= RH_HI; rh += RH_STEP) {
      if (ppdAt(t, rh, inputs, ctx) > PPD_ACCEPTABLE) continue
      envelope++
      if (!constraints.every((c) => passesConstraint(t, rh, c))) continue
      band++
      tSum += t
      rSum += rh
      if (t < tLo) tLo = t
      if (t > tHi) tHi = t
      if (rh < rhLo) rhLo = rh
      if (rh > rhHi) rhHi = rh
      points.push({ t, rh })
    }
  }
  return { band, envelope, tSum, rSum, tLo, tHi, rhLo, rhHi, points }
}

// Derive the household comfort band for a given context. Expensive (~700 PMV
// evals); callers that score many points should derive ONCE and reuse via
// scoreAgainstBand. Memoized per (inputs signature + context) below.
export function deriveBand(inputs: ModelInputs, ctx: ComfortContext): ComfortBand {
  const activeAll = inputs.constraints.filter(
    (c) => c.applies === "baseline" || (ctx.night && c.applies === "night_overlay_2200_0600"),
  )

  let working = [...activeAll]
  const dropped: Constraint[] = []
  let s = sweep(inputs, ctx, working)
  let wasEmpty = false

  // Irreconcilable constraints → relax one at a time, least-medical first.
  while (s.band === 0 && working.length > 0) {
    wasEmpty = true
    let dropIdx = 0
    let best = Infinity
    working.forEach((c, i) => {
      const r = relaxRank(c.constraint_name)
      if (r < best) {
        best = r
        dropIdx = i
      }
    })
    dropped.push(working[dropIdx])
    working = working.filter((_, i) => i !== dropIdx)
    s = sweep(inputs, ctx, working)
  }

  // Happy Number (spec v2.3 §3.1) — how specific this household's climate is.
  //   width_component: fraction of the PMV envelope that survives the household's
  //     health constraints (asthma/allergy/senior/child limits). A tighter band
  //     → smaller share → lower number. This is where every profile qualifier
  //     legitimately moves the Happy Number.
  //   centrality: how close the household's PREFERRED conditions sit to a typical
  //     climate (73°F/45%). Measured AT the preference — NOT at the band centroid
  //     — so the number describes the household's own climate, not the middle of
  //     what they would merely tolerate.
  const widthComponent = s.envelope > 0 ? (100 * s.band) / s.envelope : 0
  const centralityPref = centrality(inputs.preferred_temp_f, inputs.preferred_rh)
  const happyNumber = Math.max(1, Math.min(100, Math.round(0.6 * widthComponent + 0.4 * centralityPref)))

  return {
    happyNumber,
    bandPoints: s.band,
    envelopePoints: s.envelope,
    tLo: s.band > 0 ? s.tLo : inputs.preferred_temp_f,
    tHi: s.band > 0 ? s.tHi : inputs.preferred_temp_f,
    rhLo: s.band > 0 ? s.rhLo : inputs.preferred_rh,
    rhHi: s.band > 0 ? s.rhHi : inputs.preferred_rh,
    empty: wasEmpty,
    dropped,
    active: working,
    tolerance: inputs.tolerance,
    points: s.points,
  }
}

// Human-readable phrase for a constraint, optionally with the point's overage.
export function describeConstraint(c: Constraint, point?: { tempF: number; rh: number }): string {
  const over = (() => {
    if (!point) return ""
    if (c.max_rh != null && point.rh > c.max_rh) return ` — humidity ${Math.round(point.rh - c.max_rh)}% above your household's ceiling`
    if (c.min_rh != null && point.rh < c.min_rh) return ` — humidity ${Math.round(c.min_rh - point.rh)}% below your household's floor`
    if (c.max_temp_f != null && point.tempF > c.max_temp_f) return ` — ${Math.round(point.tempF - c.max_temp_f)}° warmer than your household's ceiling`
    if (c.min_temp_f != null && point.tempF < c.min_temp_f) return ` — ${Math.round(c.min_temp_f - point.tempF)}° cooler than your household's floor`
    return ""
  })()
  switch (c.constraint_name) {
    case "respiratory_humidity_floor":
      return `asthma/allergies need humidity at or above ${c.min_rh}%${over}`
    case "allergen_humidity_ceiling":
      return `allergies narrow your range at the humid end (max ${c.max_rh}%)${over}`
    case "asthma_humidity_ceiling":
    case "respiratory_humidity_ceiling":
      return `asthma narrows your humid range (max ${c.max_rh}%)${over}`
    case "senior_thermal_floor":
      return `seniors need it no cooler than ${c.min_temp_f}°F${over}`
    case "child_activity_ceiling":
      return `young children need it no warmer than ${c.max_temp_f}°F${over}`
    case "sleep_night_window":
      return `night comfort window ${c.min_temp_f}–${c.max_temp_f}°F${over}`
    default:
      return `${c.trigger_source}${over}`
  }
}

function buildFactors(
  tempF: number,
  rh: number,
  band: ComfortBand,
  inside: boolean,
): ComfortFactor[] {
  const factors: ComfortFactor[] = []

  // Irreconcilable-household note always surfaces (the honest finding).
  if (band.empty && band.dropped.length >= 1) {
    const names = band.dropped.map((d) => d.trigger_source).filter(Boolean)
    factors.push({
      code: "conflict",
      label:
        "Your household's needs conflict — we're targeting the closest achievable range" +
        (names.length ? ` (relaxed: ${names.join(", ")})` : ""),
      severity: "conflict",
    })
  }

  if (inside) {
    factors.push({
      code: "in_range",
      label: "Within your household's comfort range",
      severity: "good",
    })
    return factors
  }

  // Outside: name every binding constraint the point breaks.
  for (const c of band.active) {
    if (!passesConstraint(tempF, rh, c)) {
      factors.push({
        code: c.constraint_name,
        label: describeConstraint(c, { tempF, rh }),
        severity: "binding",
      })
    }
  }
  if (factors.every((f) => f.severity !== "binding")) {
    // Thermal (PPD) edge rather than a household constraint.
    factors.push({
      code: "thermal",
      label: tempF > band.tHi ? "warmer than your comfortable range" : "cooler than your comfortable range",
      severity: "binding",
    })
  }
  return factors
}

// Comfort Score (1-100) for a condition point against an already-derived band.
// Cheap — no PMV sweep. Pass the same inputs/context used to derive the band.
export function scoreAgainstBand(
  tempF: number,
  rh: number,
  band: ComfortBand,
  inputs: ModelInputs,
  ctx: ComfortContext,
): { score: number; factors: ComfortFactor[] } {
  // The number is the target-anchored curve (spec v2.3 §3.2): the Happy Number
  // at preference, 100 at the typical reference. The band is used ONLY to explain
  // the score (which health constraint binds, if any) and to decide `inside`,
  // never to shape the number.
  const passes = band.active.every((c) => passesConstraint(tempF, rh, c))
  const thermalOk = ppdAt(tempF, rh, inputs, ctx) <= PPD_ACCEPTABLE
  const inside = band.bandPoints > 0 && passes && thermalOk
  return {
    score: comfortScoreCurve(tempF, rh, band.happyNumber, inputs.preferred_temp_f, inputs.preferred_rh),
    factors: buildFactors(tempF, rh, band, inside),
  }
}

// Conditional temperature slice at the RH nearest to `atRh` (spec v2.1 §4.1).
// The raw projection tLo..tHi spans EVERY humidity, so it overstates what is
// admissible: the widest temperatures are only acceptable at extreme RH. The
// engine must clamp against the slice at the humidity the home is ACTUALLY at.
export function sliceAtRh(band: ComfortBand, atRh: number): { tLo: number; tHi: number } | null {
  if (!band.points.length) return null
  let nearestRh = band.points[0].rh
  let bestD = Infinity
  for (const p of band.points) {
    const d = Math.abs(p.rh - atRh)
    if (d < bestD) {
      bestD = d
      nearestRh = p.rh
    }
  }
  let tLo = Infinity
  let tHi = -Infinity
  for (const p of band.points) {
    if (p.rh !== nearestRh) continue
    if (p.t < tLo) tLo = p.t
    if (p.t > tHi) tHi = p.t
  }
  return Number.isFinite(tLo) ? { tLo, tHi } : null
}

export type TargetSelection = {
  targetTempF: number
  targetRh: number
  tempClampedBy: "floor" | "ceiling" | null
  rhClampedBy: "floor" | "ceiling" | null
  slice: { tLo: number; tHi: number } | null
}

// Target selection (spec v2.1 §5). Preference WINS whenever admissible; we clamp
// ONLY against health-derived limits — the conditional temperature slice at the
  // current humidity, and the RH band. The band center is never used. When a clamp
// fires the caller surfaces it in plain language.
export function selectTarget(band: ComfortBand, inputs: ModelInputs, atRh: number): TargetSelection {
  const slice = sliceAtRh(band, atRh)
  const prefT = inputs.preferred_temp_f
  const prefRh = inputs.preferred_rh

  let targetTempF = prefT
  let tempClampedBy: "floor" | "ceiling" | null = null
  if (slice) {
    if (prefT < slice.tLo) {
      targetTempF = slice.tLo
      tempClampedBy = "floor"
    } else if (prefT > slice.tHi) {
      targetTempF = slice.tHi
      tempClampedBy = "ceiling"
    }
  }

  let targetRh = prefRh
  let rhClampedBy: "floor" | "ceiling" | null = null
  if (band.bandPoints > 0) {
    if (prefRh < band.rhLo) {
      targetRh = band.rhLo
      rhClampedBy = "floor"
    } else if (prefRh > band.rhHi) {
      targetRh = band.rhHi
      rhClampedBy = "ceiling"
    }
  }

  return { targetTempF, targetRh, tempClampedBy, rhClampedBy, slice }
}

// The one canonical entry point: derive the band and score a point in one call.
// Prefer deriveBand + scoreAgainstBand when scoring many points against the
// same profile/context.
export function elevateComfort(
  tempF: number,
  rh: number,
  inputs: ModelInputs,
  ctx: ComfortContext,
): ElevateResult {
  const band = deriveBand(inputs, ctx)
  const { score, factors } = scoreAgainstBand(tempF, rh, band, inputs, ctx)
  return { score, happyNumber: band.happyNumber, band, factors }
}
