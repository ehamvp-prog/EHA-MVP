// =====================================================================
// Filter health math — measures FILTER LOAD, not absolute static.
//
// A hardcoded static threshold (e.g. 0.8" WC) is wrong for filter health:
// a home with restrictive ductwork can sit at high static with a clean
// filter and would always read "dirty". Instead we isolate the filter's
// OWN contribution using a two-point calibration, so the gauge works
// correctly on any duct system.
//
// Definitions (all static in inches of water column, "WC):
//   floor             = NO-FILTER static (filter removed). Everything
//                       downstream of the filter — primarily the
//                       evaporator coil + ductwork. Captured at calibration.
//   fresh             = FRESH-FILTER static (clean filter installed).
//   filter_drop_fresh = fresh − floor — the pressure drop of a clean filter.
//   filter_drop_now   = static_now − floor — the filter's drop right now.
//   R (load ratio)    = filter_drop_now / filter_drop_fresh — how loaded the
//                       filter is vs. when fresh. System-independent.
//
// NOTE (coil-fouling signal): because every filter change re-captures
// `floor`, the floor_static_inwc series over time is a longitudinal
// coil/duct baseline. A clean coil holds a stable floor; as the evaporator
// coil fouls, the floor creeps upward across filter changes, independent of
// the filter. We store it per event now; a future read can chart that trend
// and flag possible coil fouling. The data will already be there.
// =====================================================================

export type FilterBaseline = {
  floor_static_inwc: number
  filter_drop_fresh_inwc: number
}

export type FilterBand = "green" | "yellow" | "red" | "black"

export type FilterHealth = {
  calibrated: boolean
  // Load ratio R (>= 0). null when uncalibrated.
  ratio: number | null
  band: FilterBand | null
  label: string
  detail: string
  severe: boolean // R > 2.25 — drives the pulsing red flag
}

// Gauge arc spans load ratio R in [1, 3]. Color bands by R:
//   green  1.0 ≤ R < 1.5   healthy
//   yellow 1.5 ≤ R < 2.0   loading — plan to change
//   red    2.0 ≤ R ≤ 2.25  change now
//   black  R > 2.25        severely restricted
export const GAUGE_R_MIN = 1
export const GAUGE_R_MAX = 3
export const BAND_YELLOW = 1.5
export const BAND_RED = 2.0
export const BAND_BLACK = 2.25

export function bandForRatio(r: number): FilterBand {
  if (r < BAND_YELLOW) return "green"
  if (r < BAND_RED) return "yellow"
  if (r <= BAND_BLACK) return "red"
  return "black"
}

function copyForBand(band: FilterBand): { label: string; detail: string } {
  switch (band) {
    case "green":
      return { label: "Filter is healthy", detail: "Airflow through the filter looks like a fresh filter." }
    case "yellow":
      return { label: "Filter is loading up", detail: "Still fine, but plan to change it soon." }
    case "red":
      return { label: "Change your filter now", detail: "The filter's restriction has roughly doubled." }
    case "black":
      return { label: "Severely restricted — replace immediately", detail: "Airflow is badly choked. Running like this stresses the system." }
  }
}

// Compute filter health from a live static reading + the latest baseline.
// When uncalibrated (no baseline), returns a no-verdict result; the gauge
// shows the raw static number with a "calibrate" prompt instead of a color.
export function computeFilterHealth(
  staticNow: number | null | undefined,
  baseline: FilterBaseline | null | undefined,
): FilterHealth {
  if (
    !baseline ||
    !Number.isFinite(baseline.filter_drop_fresh_inwc) ||
    baseline.filter_drop_fresh_inwc <= 0
  ) {
    return {
      calibrated: false,
      ratio: null,
      band: null,
      label: "Calibrate for filter health",
      detail: "Run the quick two-step calibration to track this filter.",
      severe: false,
    }
  }
  if (staticNow == null || !Number.isFinite(staticNow)) {
    return {
      calibrated: true,
      ratio: null,
      band: null,
      label: "Awaiting a live reading",
      detail: "Filter health will show once a static pressure reading arrives.",
      severe: false,
    }
  }

  const dropNow = staticNow - baseline.floor_static_inwc
  // Below the floor the filter is effectively adding nothing (or a bad
  // reading); treat as fully fresh rather than emitting a negative ratio.
  // Round to 4 decimals so IEEE float error at subtraction (e.g. 0.70 − 0.40)
  // can't tip an exact boundary value into the wrong band.
  const ratio = Math.round((Math.max(0, dropNow) / baseline.filter_drop_fresh_inwc) * 10000) / 10000
  const band = bandForRatio(ratio)
  const { label, detail } = copyForBand(band)
  return { calibrated: true, ratio, band, label, detail, severe: ratio > BAND_BLACK }
}

// Map a load ratio to a 0..1 position along the gauge arc [GAUGE_R_MIN..MAX].
// R can exceed the max; the needle pins at the end and the black/flag state
// communicates the severity.
export function ratioToArcFraction(r: number): number {
  const t = (r - GAUGE_R_MIN) / (GAUGE_R_MAX - GAUGE_R_MIN)
  return Math.min(1, Math.max(0, t))
}

// Validate a two-point capture before storing. Fresh must be strictly above
// the no-filter floor — otherwise it's a bad reading and we refuse to store
// garbage that would corrupt the baseline.
export function validateCapture(
  floor: number,
  fresh: number,
): { ok: true; drop: number } | { ok: false; error: string } {
  if (!Number.isFinite(floor) || !Number.isFinite(fresh)) {
    return { ok: false, error: "Both captures need a valid live static reading." }
  }
  const drop = fresh - floor
  if (drop <= 0) {
    return {
      ok: false,
      error:
        "Fresh-filter static should be higher than no-filter static. Please redo the captures.",
    }
  }
  return { ok: true, drop: Math.round(drop * 1000) / 1000 }
}

export function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return null
  return Math.floor((Date.now() - then) / 86_400_000)
}
