// ---------------------------------------------------------------------------
// America/Chicago wall-clock helpers, DST-correct.
//
// The energy_* and savings_* ledger views, and the indoor RPCs, all bucket in
// America/Chicago with real daylight-saving handling. Frontend/read code that
// needs "what day/month is it in Chicago" MUST use a real timezone conversion,
// NOT a fixed `Date.now() - 6h` offset — that offset double-shifts the already
// Chicago-bucketed data and is wrong for half the year (during CDT).
//
// NOTE: this is deliberately NOT used by the Evergy tariff logic in
// lib/engine/cost.ts, which is defined in Central STANDARD time year-round on
// purpose. That file, and the compute/persist write path, are left untouched.
// ---------------------------------------------------------------------------

const CHICAGO = "America/Chicago"

// Wall-clock date parts in Chicago for a given instant.
export function chicagoParts(d: Date = new Date()): {
  year: number
  month: number // 1–12
  day: number // 1–31
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CHICAGO,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d)
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value)
  return { year: get("year"), month: get("month"), day: get("day") }
}

// "YYYY-MM-DD" today in Chicago (matches *_daily.day_local).
export function chicagoTodayISO(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CHICAGO,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d)
}

// "YYYY-MM-01" first-of-month in Chicago (matches *_monthly.month_local).
export function chicagoMonthStartISO(d: Date = new Date()): string {
  const { year, month } = chicagoParts(d)
  return `${year}-${String(month).padStart(2, "0")}-01`
}

// Zero-based month index (0–11) in Chicago — for seasonal clothing selection.
export function chicagoMonthIndex(d: Date = new Date()): number {
  return chicagoParts(d).month - 1
}

// UTC instant of a Chicago wall-clock time (default midnight) on the given
// calendar date. Uses the standard "guess then correct by actual offset" trick
// so it's DST-correct without hardcoding -5/-6. Needed to build precise UTC
// query windows that line up with the RPCs' day_local bucketing.
export function chicagoWallClockToUtc(
  year: number,
  month: number, // 1–12
  day: number,
  hour = 0,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, 0, 0)
  const asUtc = new Date(guess).toLocaleString("en-US", { timeZone: "UTC" })
  const asChi = new Date(guess).toLocaleString("en-US", { timeZone: CHICAGO })
  const offset = new Date(asUtc).getTime() - new Date(asChi).getTime()
  return new Date(guess + offset)
}

export type ChartView = "daily" | "weekly" | "monthly"

// Number of intraday segments per day for a given view. Weekly is denser than
// monthly so a week's detail stays legible; daily drills all the way to hourly.
export function segmentsForView(view: ChartView): number {
  return view === "daily" ? 24 : view === "weekly" ? 12 : 8
}

// Resolve a [from, to) UTC window (as ISO strings) that exactly covers the
// Chicago-local days implied by an anchor date under a given view:
//   - daily:   the single anchor day
//   - weekly:  the week-of-month chunk (1–7, 8–14, …) containing the anchor
//   - monthly: the whole anchor month
// Also returns the day list (YYYY-MM-DD, Chicago) the window spans, so callers
// can zero-fill and wire per-day drill-down.
export function chicagoChartWindow(
  view: ChartView,
  year: number,
  month: number, // 1–12
  day: number,
): { fromISO: string; toISO: string; segments: number; days: string[] } {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const safeDay = Math.min(Math.max(day, 1), daysInMonth)
  const iso = (d: number) => `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`

  let startDay: number
  let endDay: number // inclusive
  if (view === "daily") {
    startDay = endDay = safeDay
  } else if (view === "weekly") {
    const weekOfMonth = Math.min(Math.ceil(safeDay / 7), 5)
    startDay = (weekOfMonth - 1) * 7 + 1
    endDay = Math.min(weekOfMonth * 7, daysInMonth)
  } else {
    startDay = 1
    endDay = daysInMonth
  }

  const from = chicagoWallClockToUtc(year, month, startDay, 0)
  // Exclusive upper bound = midnight after the last day.
  const to = chicagoWallClockToUtc(year, month, endDay + 1, 0)
  const days: string[] = []
  for (let d = startDay; d <= endDay; d++) days.push(iso(d))

  return { fromISO: from.toISOString(), toISO: to.toISOString(), segments: segmentsForView(view), days }
}
