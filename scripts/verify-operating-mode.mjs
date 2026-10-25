// Verifies live-mode / season-mode detection and the disagreement alerts.
// Run: node scripts/verify-operating-mode.mjs
import { deriveOperatingMode } from "../lib/engine/heating/operating-mode.ts"

let pass = 0
let fail = 0
function check(name, got, want) {
  const ok = got === want
  if (ok) pass++
  else fail++
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  →  got=${got} want=${want}`)
}
const codes = (r) => r.disagreements.map((d) => d.code).sort().join(",")

const base = {
  condenserWatts: 0,
  furnaceStage: "idle",
  blowerOn: false,
  riseF: 0,
  thermostatMode: null,
  thermostatStatus: null,
  outdoorTempF: null,
  lastActiveMode: null,
}

let r = deriveOperatingMode({ ...base, condenserWatts: 1900, blowerOn: true, riseF: -18, thermostatStatus: "COOLING", thermostatMode: "COOL" })
check("condenser on = cooling", r.liveMode, "cooling")
check("  source sensors", r.liveSource, "sensors")
check("  season cooling", r.seasonMode, "cooling")
check("  no disagreements", codes(r), "")

r = deriveOperatingMode({ ...base, furnaceStage: "burn", blowerOn: true, riseF: 45, thermostatStatus: "HEATING", thermostatMode: "HEAT" })
check("furnace burn = heating", r.liveMode, "heating")
check("  season heating", r.seasonMode, "heating")
check("  no disagreements", codes(r), "")

r = deriveOperatingMode({ ...base, condenserWatts: null, furnaceStage: null, blowerOn: true, riseF: 30 })
check("rise +30 with no power data = heating", r.liveMode, "heating")
r = deriveOperatingMode({ ...base, condenserWatts: null, furnaceStage: null, blowerOn: true, riseF: -10 })
check("rise −10 with no power data = cooling", r.liveMode, "cooling")

r = deriveOperatingMode({ ...base, blowerOn: true, riseF: 1, thermostatMode: "HEAT", thermostatStatus: "OFF" })
check("fan only", r.liveMode, "fan_only")
check("  season from stat = heating", r.seasonMode, "heating")
check("  season source thermostat", r.seasonSource, "thermostat")

r = deriveOperatingMode({ ...base, thermostatMode: "HEATCOOL", thermostatStatus: "OFF", lastActiveMode: "heating" })
check("idle + HEATCOOL keeps last active (heating)", r.seasonMode, "heating")

r = deriveOperatingMode({ ...base, outdoorTempF: 38 })
check("38 °F outside, nothing else = heating", r.seasonMode, "heating")
check("  source outdoor", r.seasonSource, "outdoor")
r = deriveOperatingMode({ ...base, outdoorTempF: 88 })
check("88 °F outside, nothing else = cooling", r.seasonMode, "cooling")

r = deriveOperatingMode({ ...base, condenserWatts: 1850, blowerOn: true, riseF: -16, thermostatMode: "HEATCOOL", thermostatStatus: "COOLING", lastActiveMode: "heating" })
check("3 pm: cooling even though last active was heating", r.liveMode, "cooling")
check("  season flips to cooling", r.seasonMode, "cooling")
r = deriveOperatingMode({ ...base, furnaceStage: "burn", blowerOn: true, riseF: 40, thermostatMode: "HEATCOOL", thermostatStatus: "HEATING", lastActiveMode: "cooling" })
check("6 am: heating even though last active was cooling", r.liveMode, "heating")

r = deriveOperatingMode({ ...base, thermostatMode: "HEAT", thermostatStatus: "HEATING", furnaceStage: "idle", riseF: 0 })
check("stat HEATING, furnace idle = stat_heating_no_heat", codes(r), "stat_heating_no_heat")
check("  live mode still follows the stat for now", r.liveMode, "heating")

r = deriveOperatingMode({ ...base, thermostatMode: "COOL", thermostatStatus: "COOLING", condenserWatts: 0, riseF: 0 })
check("stat COOLING, condenser dark = stat_cooling_no_condenser", codes(r), "stat_cooling_no_condenser")

r = deriveOperatingMode({ ...base, thermostatMode: "HEAT", thermostatStatus: "OFF", furnaceStage: "burn", riseF: 40, blowerOn: true })
check("burning with no call = heat_without_call", codes(r), "heat_without_call")

r = deriveOperatingMode({ ...base, thermostatMode: "COOL", thermostatStatus: "OFF", condenserWatts: 1900, riseF: -15, blowerOn: true })
check("condenser on with no call = cool_without_call", codes(r), "cool_without_call")

// Heat pump (Rex's site): condenser ON with a HOT supply = heating.
r = deriveOperatingMode({ ...base, condenserWatts: 2100, blowerOn: true, riseF: 22, thermostatMode: "HEAT", thermostatStatus: "HEATING" })
check("heat pump: condenser on + hot supply = heating", r.liveMode, "heating")
check("  no cool_without_call on a heat pump heating", codes(r), "")

r = deriveOperatingMode({ ...base, furnaceStage: "post_purge", blowerOn: true, riseF: 20, thermostatStatus: "OFF", thermostatMode: "HEAT" })
check("post_purge = heating (not fan_only)", r.liveMode, "heating")
check("  and no heat_without_call (burner is off)", codes(r), "")

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
