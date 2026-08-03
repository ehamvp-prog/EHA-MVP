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
