// =====================================================================
// Manufacturer blower chart (OEM table) math — pure, no I/O.
//
// A chart is a list of printed cells: tap × external static → CFM (and
// watts when the manufacturer prints them). Airflow at the measured static
// is read off the chart for the tap the blower is on, interpolating only
// between printed static columns (never extrapolating past the chart).
//
// Which tap?
//   entered          the tap typed in Setup (heat tap / cool tap)
//   matched_watts    the chart prints watts and the measured blower watts
//                    pick out one tap clearly (cooling / fan only — in heat
//                    the furnace circuit also carries the inducer)
//   factory_default  the manufacturer's default tap for that call — a guess
// =====================================================================

export interface OemPoint {
  tap: string
  tapOrder: number | null
  useFor: string | null
  staticInWc: number | null // null = constant-CFM setting
  cfm: number
  watts: number | null
}

export interface OemChart {
  id: string
  brand: string
  family: string | null
  modelPattern: string
  motorType: string | null
  checked: boolean
  defaultTaps: Record<string, string> | null
  hasWatts: boolean
  sourceUrl: string
  points: OemPoint[]
  // Manufacturer ratings printed with the chart (furnaces), when stored.
  ratings?: {
    inputBtuh: number | null
    outputBtuh: number | null
    afuePct: number | null
    riseMinF: number | null
    riseMaxF: number | null
  }
}

export type TapSource = "entered" | "matched_watts" | "factory_default"
export type AirMode = "heat" | "cool" | "fan"

export interface OemAirflow {
  enteredTapUnmatched: boolean // a tap was entered but isn't printed on this chart
  cfm: number
  tap: string
  tapSource: TapSource
  staticUsed: number | null
  outsideChart: boolean // measured static past the printed columns (edge value used)
  constantCfm: boolean
}

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "")

/** Model numbers on the label vs chart prefixes: compare letters/digits only. */
export function chartMatchesModel(modelPattern: string, model: string): boolean {
  const p = norm(modelPattern)
  return p.length > 0 && norm(model).startsWith(p)
}

export function chartTaps(chart: OemChart): string[] {
  return Array.from(new Set(chart.points.map((p) => p.tap))).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
  )
}

/**
 * Resolve what someone typed ("5", "F5", "tap 5", "med-hi", "blue") to a tap
 * printed on the chart. Exact (letters/digits only) first, then the same
 * trailing number (Goodman "5" → "F05", Trane "5" → "5").
 */
export function resolveTap(
  chart: OemChart,
  typed: string | null | undefined,
  opts: { exactOnly?: boolean } = {},
): string | null {
  if (typed == null || String(typed).trim() === "") return null
  const want = norm(String(typed))
  const taps = chartTaps(chart)
  const exact = taps.find((t) => norm(t) === want)
  if (exact) return exact
  // A bare number ("5") against lettered taps ("F05") could be a different
  // motor revision (e.g. 5-tap vs 9-speed board) — only map it when allowed.
  if (opts.exactOnly) return null
  const num = want.match(/(\d+)$/)?.[1]
  if (num) {
    const n = Number(num)
    const byNum = taps.filter((t) => {
      const m = norm(t).match(/(\d+)$/)
      return m != null && Number(m[1]) === n
    })
    if (byNum.length === 1) return byNum[0]
  }
  return null
}

function defaultTapFor(chart: OemChart, mode: AirMode): string | null {
  const d = chart.defaultTaps ?? {}
  const pick =
    mode === "heat" ? d.heat : mode === "cool" ? (d.cool ?? d.cool_low ?? d.cool_high) : (d.fan ?? d.circulation)
  return pick ? resolveTap(chart, pick) : null
}

/** CFM for one tap at a static, interpolated between printed columns. */
export function cfmAtStatic(
  chart: OemChart,
  tap: string,
  staticInWc: number | null,
): { cfm: number; staticUsed: number | null; outside: boolean; constantCfm: boolean } | null {
  const pts = chart.points.filter((p) => p.tap === tap)
  if (!pts.length) return null
  const flat = pts.filter((p) => p.staticInWc == null)
  if (flat.length && pts.every((p) => p.staticInWc == null)) {
    return { cfm: flat[0].cfm, staticUsed: null, outside: false, constantCfm: true }
  }
  if (staticInWc == null || !Number.isFinite(staticInWc)) return null
  const curve = pts
    .filter((p) => p.staticInWc != null)
    .sort((a, b) => a.staticInWc! - b.staticInWc!)
  if (!curve.length) return null
  const lo = curve[0]
  const hi = curve[curve.length - 1]
  if (staticInWc <= lo.staticInWc!) {
    return { cfm: lo.cfm, staticUsed: lo.staticInWc, outside: staticInWc < lo.staticInWc!, constantCfm: false }
  }
  if (staticInWc >= hi.staticInWc!) {
    return { cfm: hi.cfm, staticUsed: hi.staticInWc, outside: staticInWc > hi.staticInWc!, constantCfm: false }
  }
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i]
    const b = curve[i + 1]
    if (staticInWc >= a.staticInWc! && staticInWc <= b.staticInWc!) {
      const f = (staticInWc - a.staticInWc!) / (b.staticInWc! - a.staticInWc!)
      return { cfm: a.cfm + f * (b.cfm - a.cfm), staticUsed: staticInWc, outside: false, constantCfm: false }
    }
  }
  return null
}

/** Watts printed for a tap at a static (interpolated), when the chart has them. */
function wattsAtStatic(chart: OemChart, tap: string, staticInWc: number): number | null {
  const curve = chart.points
    .filter((p) => p.tap === tap && p.staticInWc != null && p.watts != null)
    .sort((a, b) => a.staticInWc! - b.staticInWc!)
  if (curve.length < 2) return null
  if (staticInWc < curve[0].staticInWc! || staticInWc > curve[curve.length - 1].staticInWc!) return null
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i]
    const b = curve[i + 1]
    if (staticInWc >= a.staticInWc! && staticInWc <= b.staticInWc!) {
      const f = (staticInWc - a.staticInWc!) / (b.staticInWc! - a.staticInWc!)
      return a.watts! + f * (b.watts! - a.watts!)
    }
  }
  return null
}

/**
 * Pick the tap whose printed watts best match the measured blower watts at
 * the measured static. Only answers when one tap is clearly closest (within
 * 12% and at least 6% closer than the runner-up).
 */
export function matchTapByWatts(
  chart: OemChart,
  staticInWc: number | null,
  blowerWatts: number | null,
  mode: AirMode,
): string | null {
  if (!chart.hasWatts || staticInWc == null || blowerWatts == null || blowerWatts <= 0) return null
  const scored = chartTaps(chart)
    .filter((tap) => {
      const use = chart.points.find((p) => p.tap === tap)?.useFor
      return !(mode === "heat" && use === "not_for_heat")
    })
    .map((tap) => {
      const w = wattsAtStatic(chart, tap, staticInWc)
      return w == null ? null : { tap, err: Math.abs(w - blowerWatts) / blowerWatts }
    })
    .filter((x): x is { tap: string; err: number } => x != null)
    .sort((a, b) => a.err - b.err)
  if (!scored.length) return null
  const best = scored[0]
  const next = scored[1]
  if (best.err > 0.12) return null
  if (next && next.err - best.err < 0.06) return null
  return best.tap
}

/**
 * Airflow from the chart for this call. Returns null when no tap can be
 * settled or the static is missing for a static-based chart.
 */
export function oemAirflow(input: {
  chart: OemChart
  mode: AirMode
  enteredTap: string | null | undefined
  staticInWc: number | null
  blowerWatts: number | null
}): OemAirflow | null {
  const { chart, mode } = input
  // Entered taps must match the chart's own labels; "5" is not assumed to be "F05".
  let tap = resolveTap(chart, input.enteredTap, { exactOnly: true })
  const enteredTapUnmatched = !tap && input.enteredTap != null && String(input.enteredTap).trim() !== ""
  let tapSource: TapSource = "entered"
  if (!tap && mode !== "heat") {
    // The furnace circuit also carries the inducer while heating, so watts
    // only identify the tap in cooling / fan-only.
    tap = matchTapByWatts(chart, input.staticInWc, input.blowerWatts, mode)
    tapSource = "matched_watts"
  }
  if (!tap) {
    tap = defaultTapFor(chart, mode)
    tapSource = "factory_default"
  }
  if (!tap) return null
  const r = cfmAtStatic(chart, tap, input.staticInWc)
  if (!r) return null
  return {
    cfm: Math.round(r.cfm),
    tap,
    tapSource,
    staticUsed: r.staticUsed,
    outsideChart: r.outside,
    constantCfm: r.constantCfm,
    enteredTapUnmatched,
  }
}

export function tapSourceLabel(s: TapSource): string {
  return s === "entered" ? "tap entered" : s === "matched_watts" ? "tap matched from watts" : "tap guessed (factory default)"
}
