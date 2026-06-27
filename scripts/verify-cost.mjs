// Verifies Evergy RTOU period/season/holiday logic against known cases.
// Run: node scripts/verify-cost.mjs
import {
  computeCost,
  toCstParts,
  isRtouHoliday,
  touPeriodFor,
  seasonForMonth,
} from "../lib/engine/cost.ts"

let pass = 0
let fail = 0
function check(label, got, want) {
  const ok = got === want
  if (ok) pass++
  else fail++
  console.log(`[v0] ${ok ? "PASS" : "FAIL"}  ${label}  got=${got} want=${want}`)
}

// Helper: build a UTC ISO that lands on a specific CST wall-clock time.
// CST = UTC-6, so CST hour H on date D => UTC hour H+6.
function cst(year, month, day, hour) {
  const utcHour = hour + 6
  const d = new Date(Date.UTC(year, month - 1, day, utcHour, 0, 0))
  return d.toISOString()
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

console.log("[v0] ---- CST year-round (no DST) ----")
// In July, naive US Central would be CDT (UTC-5). We force CST (UTC-6).
// A reading at UTC 2025-07-15T22:00Z => CST 16:00 (4pm) = on-peak.
// Under CDT it'd be 17:00, still on-peak, so test a boundary instead:
// UTC 2025-07-16T01:00Z => CST 19:00 (on-peak). Under CDT=20:00 (off). Expect on-peak.
check("CST boundary 7pm on-peak", computeCost(0, "2025-07-16T01:00:00Z").tou_period, "on_peak")
// UTC 2025-07-16T02:00Z => CST 20:00 (off). Under CDT=21:00 (off). Expect off.
check("CST boundary 8pm off-peak", computeCost(0, "2025-07-16T02:00:00Z").tou_period, "off_peak")

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
