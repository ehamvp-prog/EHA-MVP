// =====================================================================
// Maps raw telemetry devices to HVAC roles and pulls the numbers the
// engine needs.
//
// Role detection is by device_id / device_type keywords AND by the field
// names present in the payload, so namespaced Shelly payloads (e.g.
// `condenser_total_watts`, `blower_watts`, `static_pressure_inwc`) are
// understood directly — not just generic keys like `watts`/`temp_f`.
//
// A single device may carry MORE THAN ONE role. In particular a combined
// return + static sensor (`dht22_static`) reports return air temp/RH AND
// static pressure in one payload; we extract all of it (no early skip).
// =====================================================================

export interface LatestDevice {
  device_id: string
  device_type: string | null
  payload: Record<string, unknown>
  recorded_at?: string | null
  received_at?: string | null
}

export interface HvacInputs {
  condenserWattsLeg1: number | null
  condenserWattsLeg2: number | null
  condenserTotalWatts: number | null
  blowerWatts: number | null
  totalWatts: number | null
  returnTempF: number | null
  returnRh: number | null
  supplyTempF: number | null
  supplyRh: number | null
  staticInWc: number | null
  matched: {
    condenserLegs: string[]
    blower: string | null
    supply: string | null
    return: string | null
    static: string | null
  }
}

function num(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
      return Number(v)
    }
  }
  return null
}

const has = (s: string, ...keys: string[]) => keys.some((k) => s.toLowerCase().includes(k))

const cToF = (c: number | null) => (c == null ? null : (c * 9) / 5 + 32)

/** Active electrical power (W) from common Shelly shapes + a name prefix. */
function powerWatts(p: Record<string, unknown>, prefix = ""): number | null {
  const pre = (s: string) => p[`${prefix}${s}`]
  const direct = num(
    pre("watts"),
    pre("act_power"),
    pre("apower"),
    pre("power"),
    pre("active_power"),
    p.act_power,
    p.apower,
    p.power,
    p.watts,
    p.active_power,
  )
  if (direct != null) return direct
  // Fall back to volts * amps if no power field is present.
  const v = num(pre("voltage"), p.voltage, p.volts, p.v)
  const a = num(pre("current"), p.current, p.amps, p.amperes, p.a)
  if (v != null && a != null) return v * a
  return null
}

function tempF(p: Record<string, unknown>, side: "supply" | "return"): number | null {
  const f = num(
    p[`${side}_temp_f`],
    p[`${side}_tempF`],
    p.temp_f,
    p.tempF,
    p.tF,
    p.temperature_f,
  )
  if (f != null) return f
  // Accept Celsius if that's all we got.
  return cToF(num(p[`${side}_temp_c`], p.temp_c, p.tempC, p.temperature_c))
}

function rh(p: Record<string, unknown>, side: "supply" | "return"): number | null {
  return num(
    p[`${side}_rh`],
    p[`${side}_humidity`],
    p.rh,
    p.humidity,
    p.relative_humidity,
    p.rh_pct,
  )
}

function staticPressure(p: Record<string, unknown>): number | null {
  return num(
    p.static_pressure_inwc,
    p.static_inwc,
    p.inwc,
    p.static_pressure,
    p.pressure_inwc,
    p.tesp,
  )
}

export function extractHvacInputs(devices: LatestDevice[]): HvacInputs {
  let condenser: { id: string; leg1: number | null; leg2: number | null; total: number | null } | null =
    null
  let blower: { id: string; watts: number | null } | null = null
  let supply: { id: string; t: number | null; h: number | null } | null = null
  let ret: { id: string; t: number | null; h: number | null } | null = null
  let staticDev: { id: string; v: number | null } | null = null

  for (const d of devices) {
    const id = d.device_id ?? ""
    const type = d.device_type ?? ""
    const p = d.payload ?? {}
    const tag = `${id} ${type}`

    const looksCondenser =
      has(tag, "cond", "compressor", "outdoor") ||
      p.condenser_total_watts != null ||
      p.condenser_leg1_watts != null
    const looksBlower =
      has(tag, "blower", "ahu", "air-handler", "airhandler", "furnace", "handler") ||
      p.blower_watts != null

    // --- Power devices (single role each) ---
    if (looksCondenser) {
      const leg1 = num(p.condenser_leg1_watts, p.leg1_watts, p.l1_watts)
      const leg2 = num(p.condenser_leg2_watts, p.leg2_watts, p.l2_watts)
      let total = num(p.condenser_total_watts, p.total_watts, p.total_act_power)
      if (total == null) {
        total = leg1 != null || leg2 != null ? (leg1 ?? 0) + (leg2 ?? 0) : powerWatts(p, "condenser_")
      }
      condenser = { id, leg1, leg2, total }
      continue
    }
    if (looksBlower) {
      blower = { id, watts: powerWatts(p, "blower_") }
      continue
    }

    // --- Air-side sensors: a device may be BOTH static and return/supply ---
    const hasStatic =
      has(tag, "static", "tesp") || p.static_pressure_inwc != null || p.static_inwc != null
    if (hasStatic) {
      staticDev = { id, v: staticPressure(p) }
      // fall through — same device may carry return/supply air data
    }

    const isSupply = has(tag, "supply") || p.supply_temp_f != null || p.supply_rh != null
    const isReturn =
      has(tag, "return") ||
      p.return_temp_f != null ||
      p.return_rh != null ||
      (has(tag, "dht") && !isSupply)

    if (isSupply) {
      supply = { id, t: tempF(p, "supply"), h: rh(p, "supply") }
    }
    if (isReturn) {
      ret = { id, t: tempF(p, "return"), h: rh(p, "return") }
    }
  }

  const leg1 = condenser?.leg1 ?? null
  const leg2 = condenser?.leg2 ?? null
  const condTotal = condenser?.total ?? null
  const blowerW = blower?.watts ?? null

  const totalWatts =
    condTotal == null && blowerW == null ? null : (condTotal ?? 0) + (blowerW ?? 0)

  return {
    condenserWattsLeg1: leg1,
    condenserWattsLeg2: leg2,
    condenserTotalWatts: condTotal,
    blowerWatts: blowerW,
    totalWatts,
    returnTempF: ret?.t ?? null,
    returnRh: ret?.h ?? null,
    supplyTempF: supply?.t ?? null,
    supplyRh: supply?.h ?? null,
    staticInWc: staticDev?.v ?? null,
    matched: {
      condenserLegs: condenser ? [condenser.id] : [],
      blower: blower?.id ?? null,
      supply: supply?.id ?? null,
      return: ret?.id ?? null,
      static: staticDev?.id ?? null,
    },
  }
}
