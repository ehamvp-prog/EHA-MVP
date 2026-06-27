// =====================================================================
// Maps raw telemetry devices to HVAC roles and pulls the numbers the
// engine needs. Role detection is by device_id / device_type keywords.
// Condenser legs are summed regardless of order ("no script-side
// doubling" — each leg is counted once).
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

const has = (s: string, ...keys: string[]) =>
  keys.some((k) => s.toLowerCase().includes(k))

/** Active electrical power in watts from common Shelly field shapes. */
function powerWatts(p: Record<string, unknown>): number | null {
  const direct = num(p.act_power, p.apower, p.power, p.watts, p.active_power)
  if (direct != null) return direct
  // Fall back to volts * amps if no power field is present.
  const v = num(p.voltage, p.volts, p.v)
  const a = num(p.current, p.amps, p.amperes, p.a)
  if (v != null && a != null) return v * a
  return null
}

function tempF(p: Record<string, unknown>): number | null {
  return num(p.temp_f, p.tempF, p.tF, p.temperature_f, p.supply_temp_f, p.return_temp_f)
}

function rh(p: Record<string, unknown>): number | null {
  return num(p.rh, p.humidity, p.relative_humidity, p.rh_pct)
}

function staticPressure(p: Record<string, unknown>): number | null {
  return num(p.static_inwc, p.inwc, p.static_pressure, p.tesp, p.pressure_inwc)
}

export function extractHvacInputs(devices: LatestDevice[]): HvacInputs {
  const condenserLegs: { id: string; watts: number | null }[] = []
  let blower: { id: string; watts: number | null } | null = null
  let supply: { id: string; t: number | null; h: number | null } | null = null
  let ret: { id: string; t: number | null; h: number | null } | null = null
  let staticDev: { id: string; v: number | null } | null = null

  for (const d of devices) {
    const id = d.device_id ?? ""
    const type = d.device_type ?? ""
    const p = d.payload ?? {}
    const tag = `${id} ${type}`

    // Static pressure transducer
    if (has(tag, "static", "tesp", "pressure") && !has(tag, "baromet")) {
      staticDev = { id, v: staticPressure(p) }
      continue
    }
    // DHT22 supply / return
    if (has(tag, "dht", "supply", "return")) {
      if (has(tag, "supply")) {
        supply = { id, t: tempF(p), h: rh(p) }
        continue
      }
      if (has(tag, "return")) {
        ret = { id, t: tempF(p), h: rh(p) }
        continue
      }
    }
    // Blower / air handler / furnace power
    if (has(tag, "blower", "air-handler", "airhandler", "furnace", "handler")) {
      blower = { id, watts: powerWatts(p) }
      continue
    }
    // Condenser legs (sum every condenser-classified leg once)
    if (has(tag, "cond", "compressor", "outdoor", "em")) {
      condenserLegs.push({ id, watts: powerWatts(p) })
      continue
    }
  }

  const leg1 = condenserLegs[0]?.watts ?? null
  const leg2 = condenserLegs[1]?.watts ?? null
  const blowerW = blower?.watts ?? null

  const condSum = condenserLegs.reduce(
    (acc, l) => (l.watts != null ? (acc ?? 0) + l.watts : acc),
    null as number | null,
  )
  const totalWatts =
    condSum == null && blowerW == null
      ? null
      : (condSum ?? 0) + (blowerW ?? 0)

  return {
    condenserWattsLeg1: leg1,
    condenserWattsLeg2: leg2,
    blowerWatts: blowerW,
    totalWatts,
    returnTempF: ret?.t ?? null,
    returnRh: ret?.h ?? null,
    supplyTempF: supply?.t ?? null,
    supplyRh: supply?.h ?? null,
    staticInWc: staticDev?.v ?? null,
    matched: {
      condenserLegs: condenserLegs.map((l) => l.id),
      blower: blower?.id ?? null,
      supply: supply?.id ?? null,
      return: ret?.id ?? null,
      static: staticDev?.id ?? null,
    },
  }
}
