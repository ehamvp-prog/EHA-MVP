// Verifies Evergy RTOU period/season/holiday logic against known cases.
// Run: node scripts/verify-cost.mjs
import "./_ts-resolve.mjs"
const { computeCost, toCstParts, isRtouHoliday, touPeriodFor, seasonForMonth } = await import(
  "../lib/engine/cost.ts"
)

let pass = 0
let fail = 0
function check(label, got, want) {
  const ok = got === want
  if (ok) pass++
  else fail++
  console.log(`[v0] ${ok ? "PASS" : "FAIL"}  ${label}  got=${got} want=${want}`)
}

// Helper: build a UTC ISO that lands on a specific Kansas City wall-clock hour
// (CDT = UTC-5 in summer, CST = UTC-6 in winter). Uses Intl directly so it is
// independent of the code under test.
const chicagoHour = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  hour: "2-digit",
  hourCycle: "h23",
})
function cst(year, month, day, hour) {
  for (const offset of [5, 6]) {
    const d = new Date(Date.UTC(year, month - 1, day, hour + offset, 0, 0))
    if (Number(chicagoHour.format(d)) === hour) return d.toISOString()
  }
  throw new Error(`no Chicago instant for ${year}-${month}-${day} ${hour}:00`)
}

console.log("[v0] ---- season ----")
check("June is summer", seasonForMonth(6), "summer")
check("Sept is summer", seasonForMonth(9), "summer")
check("Oct is winter", seasonForMonth(10), "winter")
check("May is winter", seasonForMonth(5), "winter")
check("Jan is winter", seasonForMonth(1), "winter")

console.log("[v0] ---- TOU period (weekday, non-holiday) ----")
// Tue 2025-07-15 (summer weekday)
check("3am -> super off", touPeriodFor(toCstParts(cst(2025, 7, 15, 3))), "super_off_peak")
check("6am -> off (boundary)", touPeriodFor(toCstParts(cst(2025, 7, 15, 6))), "off_peak")
check("10am -> off", touPeriodFor(toCstParts(cst(2025, 7, 15, 10))), "off_peak")
check("4pm -> on", touPeriodFor(toCstParts(cst(2025, 7, 15, 16))), "on_peak")
check("7pm -> on", touPeriodFor(toCstParts(cst(2025, 7, 15, 19))), "on_peak")
check("8pm -> off (boundary)", touPeriodFor(toCstParts(cst(2025, 7, 15, 20))), "off_peak")
check("11pm -> off", touPeriodFor(toCstParts(cst(2025, 7, 15, 23))), "off_peak")

console.log("[v0] ---- weekend has no on-peak ----")
// Sat 2025-07-19, Sun 2025-07-20
check("Sat 5pm -> off", touPeriodFor(toCstParts(cst(2025, 7, 19, 17))), "off_peak")
check("Sun 5pm -> off", touPeriodFor(toCstParts(cst(2025, 7, 20, 17))), "off_peak")
check("Sat 2am -> super off", touPeriodFor(toCstParts(cst(2025, 7, 19, 2))), "super_off_peak")

console.log("[v0] ---- holidays (fixed) ----")
check("New Year Jan 1", isRtouHoliday(toCstParts(cst(2025, 1, 1, 12))), true)
check("July 4", isRtouHoliday(toCstParts(cst(2025, 7, 4, 12))), true)
check("Christmas Dec 25", isRtouHoliday(toCstParts(cst(2025, 12, 25, 12))), true)
check("Random Jul 15 not holiday", isRtouHoliday(toCstParts(cst(2025, 7, 15, 12))), false)

console.log("[v0] ---- holidays (floating, 2025) ----")
// Memorial Day 2025 = Mon May 26; Labor Day 2025 = Mon Sep 1; Thanksgiving 2025 = Thu Nov 27
check("Memorial Day May 26 2025", isRtouHoliday(toCstParts(cst(2025, 5, 26, 12))), true)
check("Not Memorial May 19 2025", isRtouHoliday(toCstParts(cst(2025, 5, 19, 12))), false)
check("Labor Day Sep 1 2025", isRtouHoliday(toCstParts(cst(2025, 9, 1, 12))), true)
check("Thanksgiving Nov 27 2025", isRtouHoliday(toCstParts(cst(2025, 11, 27, 12))), true)

console.log("[v0] ---- holiday suppresses on-peak ----")
// July 4 2025 is a Friday, 5pm would be on-peak but it's a holiday
check("July 4 5pm -> off (holiday)", touPeriodFor(toCstParts(cst(2025, 7, 4, 17))), "off_peak")

console.log("[v0] ---- local prevailing time (DST-aware, matches eha_tou_period) ----")
// Literal UTC instants, so these do not depend on the cst() helper.
// Summer (CDT, UTC-5): Tue 2025-07-15.
check("CDT 15:59 -> off", computeCost(0, "2025-07-15T20:59:00Z").tou_period, "off_peak")
check("CDT 16:00 -> on (fixed UTC-6 said 15:00 off)", computeCost(0, "2025-07-15T21:00:00Z").tou_period, "on_peak")
check("CDT 19:00 -> on", computeCost(0, "2025-07-16T00:00:00Z").tou_period, "on_peak")
check("CDT 20:00 -> off (fixed UTC-6 said 19:00 on)", computeCost(0, "2025-07-16T01:00:00Z").tou_period, "off_peak")
check("CDT hour from 2025-07-15T21:00Z", toCstParts("2025-07-15T21:00:00Z").hour, 16)
// Winter (CST, UTC-6): Wed 2025-01-15.
check("CST 16:00 -> on", computeCost(0, "2025-01-15T22:00:00Z").tou_period, "on_peak")
check("CST 20:00 -> off", computeCost(0, "2025-01-16T02:00:00Z").tou_period, "off_peak")
check("CST hour from 2025-01-15T22:00Z", toCstParts("2025-01-15T22:00:00Z").hour, 16)
// Spring-forward night 2025-03-09: 07:30Z = 01:30 CST, 08:30Z = 03:30 CDT.
check("DST night 01:30 CST hour", toCstParts("2025-03-09T07:30:00Z").hour, 1)
check("DST night 03:30 CDT hour", toCstParts("2025-03-09T08:30:00Z").hour, 3)
// Local midnight decides the date and weekday: 2025-07-16T04:30Z = Tue 23:30 CDT.
check("23:30 CDT still Tuesday", toCstParts("2025-07-16T04:30:00Z").weekday, 2)
check("23:30 CDT still the 15th", toCstParts("2025-07-16T04:30:00Z").day, 15)

console.log("[v0] ---- rates + cost_per_hour ----")
const c1 = computeCost(3400, cst(2025, 7, 15, 17)) // summer on-peak, 3400W
check("summer on-peak rate", c1.rate_per_kwh, 0.26838)
check("cost/hr 3.4kW * 0.26838", c1.cost_per_hour, Math.round(3.4 * 0.26838 * 10000) / 10000)
const c2 = computeCost(3400, cst(2025, 1, 15, 3)) // winter super off-peak
check("winter super off rate", c2.rate_per_kwh, 0.02879)
const c3 = computeCost(null, cst(2025, 7, 15, 17))
check("null watts -> null cost", c3.cost_per_hour, null)

console.log(`\n[v0] RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
