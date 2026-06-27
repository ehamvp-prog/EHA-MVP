// =====================================================================
// Evergy Kansas Metro — Schedule RTOU (Residential Time-of-Use)
// Tariff effective 2024-10-22. MVP scope: tariff-schedule ENERGY cost only.
// Riders (ECA, EER, PTS, TA, TDC) are intentionally EXCLUDED for now.
//
// Period rules (per tariff):
//   - Super off-peak: 12am–6am every day            (highest precedence)
//   - On-peak:        4pm–8pm Mon–Fri, NOT holidays
//   - Off-peak:       all other hours
//   - Season: Summer = Jun–Sep, Winter = Oct–May
//   - All period/season logic uses CENTRAL STANDARD TIME year-round
//     (fixed UTC-6, no daylight saving), as stated by the tariff.
// =====================================================================

export type TouPeriod = "on_peak" | "off_peak" | "super_off_peak"
export type Season = "summer" | "winter"

export const MONTHLY_CUSTOMER_CHARGE = 14.25

// $/kWh by season and period. These are the published RTOU rates.
export const RTOU_RATES: Record<Season, Record<TouPeriod, number>> = {
  summer: {
    on_peak: 0.26838,
    off_peak: 0.07668,
    super_off_peak: 0.03834,
  },
  winter: {
    on_peak: 0.20151,
    off_peak: 0.05758,
    super_off_peak: 0.02879,
  },
}

// ---------------------------------------------------------------------
// CST wall-clock parts. The tariff is defined in Central STANDARD time
// year-round, so we shift UTC by a fixed -6 hours and read the parts.
// This deliberately ignores daylight saving.
// ---------------------------------------------------------------------
interface CstParts {
  year: number
  month: number // 1-12
  day: number // 1-31
  hour: number // 0-23
  weekday: number // 0=Sun ... 6=Sat
}

export function toCstParts(timestamp: string | Date): CstParts {
  const d = typeof timestamp === "string" ? new Date(timestamp) : timestamp
  // Shift by -6h, then read the UTC fields = CST wall clock.
  const shifted = new Date(d.getTime() - 6 * 60 * 60 * 1000)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    weekday: shifted.getUTCDay(),
  }
}

// ---------------------------------------------------------------------
// Holidays excluded from on-peak (Evergy RTOU):
//   New Year's Day, Memorial Day, Independence Day, Labor Day,
//   Thanksgiving, Christmas.
// Some are fixed-date, some are floating. All computed in CST.
// ---------------------------------------------------------------------

// nth weekday of a month, e.g. nthWeekday(2024, 5, 1, 5) = ... not used directly.
function lastWeekdayOfMonth(year: number, month: number, weekday: number): number {
  // month is 1-12. Find the last `weekday` (0=Sun..6=Sat) date in that month.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate() // day 0 of next month
  for (let day = lastDay; day >= 1; day--) {
    if (new Date(Date.UTC(year, month - 1, day)).getUTCDay() === weekday) return day
  }
  return lastDay
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): number {
  let count = 0
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  for (let day = 1; day <= lastDay; day++) {
    if (new Date(Date.UTC(year, month - 1, day)).getUTCDay() === weekday) {
      count++
      if (count === n) return day
    }
  }
  return lastDay
}

export function isRtouHoliday(parts: CstParts): boolean {
  const { year, month, day } = parts

  // Fixed-date holidays
  if (month === 1 && day === 1) return true // New Year's Day
  if (month === 7 && day === 4) return true // Independence Day
  if (month === 12 && day === 25) return true // Christmas

  // Memorial Day: last Monday of May
  if (month === 5 && day === lastWeekdayOfMonth(year, 5, 1)) return true

  // Labor Day: first Monday of September
  if (month === 9 && day === nthWeekdayOfMonth(year, 9, 1, 1)) return true

  // Thanksgiving: fourth Thursday of November
  if (month === 11 && day === nthWeekdayOfMonth(year, 11, 4, 4)) return true

  return false
}

// ---------------------------------------------------------------------
// Season + period determination
// ---------------------------------------------------------------------
export function seasonForMonth(month: number): Season {
  // Summer = June–September (6–9). Winter = October–May.
  return month >= 6 && month <= 9 ? "summer" : "winter"
}

export function touPeriodFor(parts: CstParts): TouPeriod {
  // Super off-peak takes precedence: 12am–6am daily.
  if (parts.hour >= 0 && parts.hour < 6) return "super_off_peak"

  // On-peak: 4pm–8pm (16:00–19:59), Mon–Fri, excluding holidays.
  const isWeekday = parts.weekday >= 1 && parts.weekday <= 5
  if (isWeekday && !isRtouHoliday(parts) && parts.hour >= 16 && parts.hour < 20) {
    return "on_peak"
  }

  // Everything else is off-peak.
  return "off_peak"
}

export interface CostResult {
  season: Season
  tou_period: TouPeriod
  rate_per_kwh: number
  // Instantaneous cost if the system ran a full hour at the current watts.
  cost_per_hour: number | null
}

// Compute the live cost rate for a timestamp + current total watts.
// cost_per_hour = (total_watts / 1000) * rate_per_kwh
export function computeCost(totalWatts: number | null, timestamp: string | Date): CostResult {
  const parts = toCstParts(timestamp)
  const season = seasonForMonth(parts.month)
  const tou_period = touPeriodFor(parts)
  const rate_per_kwh = RTOU_RATES[season][tou_period]

  const cost_per_hour =
    totalWatts != null && Number.isFinite(totalWatts)
      ? Math.round((totalWatts / 1000) * rate_per_kwh * 10000) / 10000
      : null

  return { season, tou_period, rate_per_kwh, cost_per_hour }
}
