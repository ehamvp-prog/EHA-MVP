// =====================================================================
// Phase 1 is about SEEING raw sensor fields and confirming their names.
// We don't hard-map roles yet. Instead we read whatever numeric fields
// a device sends and give each a sensible label, unit, and gauge range.
// =====================================================================

export type FieldInfo = {
  key: string
  label: string
  unit: string
  min: number
  max: number
  value: number
}

const PRETTY: Record<string, string> = {
  v: "Voltage",
  volt: "Voltage",
  voltage: "Voltage",
  a: "Current",
  amp: "Current",
  amps: "Current",
  current: "Current",
  w: "Power",
  watt: "Power",
  watts: "Power",
  power: "Power",
  rh: "Humidity",
  humidity: "Humidity",
  pf: "Power Factor",
}

function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

// Decide unit + range from the field name. Keeps gauges readable.
function rangeFor(key: string, value: number): { unit: string; min: number; max: number } {
  const k = key.toLowerCase()
  if (/(temp).*f$|tempf|_f$|temp_f/.test(k)) return { unit: "°F", min: 0, max: 120 }
  if (/(temp).*c$|tempc|_c$|temp_c/.test(k)) return { unit: "°C", min: -20, max: 60 }
  if (/(rh|humid)/.test(k)) return { unit: "%", min: 0, max: 100 }
  if (/(watt|power|^w$|_w$|act_power|apower)/.test(k)) return { unit: "W", min: 0, max: 5000 }
  if (/(volt|^v$|_v$|voltage)/.test(k)) return { unit: "V", min: 0, max: 260 }
  if (/(amp|current|^a$|_a$)/.test(k)) return { unit: "A", min: 0, max: 60 }
  if (/(static|press|pa|inwc|inh2o)/.test(k)) return { unit: "", min: 0, max: Math.max(value * 2, 2) }
  if (/(freq|hz)/.test(k)) return { unit: "Hz", min: 0, max: 80 }
  // generic fallback: scale around the value
  const max = value <= 0 ? 1 : value * 1.6
  return { unit: "", min: 0, max: Math.ceil(max) }
}

function prettyLabel(key: string): string {
  const k = key.toLowerCase()
  for (const token of Object.keys(PRETTY)) {
    if (k === token) return PRETTY[token]
  }
  return titleCase(key)
}

// Pull all numeric, gauge-worthy fields out of a raw payload.
// Skips bookkeeping keys that aren't real readings.
const SKIP = new Set([
  "device_id",
  "device_type",
  "site_id",
  "recorded_at",
  "received_at",
  "ts",
  "timestamp",
  "id",
])

export function extractFields(payload: Record<string, unknown> | null | undefined): FieldInfo[] {
  if (!payload || typeof payload !== "object") return []
  const out: FieldInfo[] = []
  for (const [key, raw] of Object.entries(payload)) {
    if (SKIP.has(key.toLowerCase())) continue
    const num = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" && !isNaN(Number(raw)) ? Number(raw) : null
    if (num == null || !isFinite(num)) continue
    const { unit, min, max } = rangeFor(key, num)
    out.push({ key, label: prettyLabel(key), unit, min, max, value: num })
  }
  return out
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—"
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (secs < 60) return `${secs}s ago`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

// Fresh < 30s green, < 2m amber, else red. Used for the live status dot.
export function freshness(iso: string | null | undefined): "live" | "stale" | "dead" {
  if (!iso) return "dead"
  const secs = (Date.now() - new Date(iso).getTime()) / 1000
  if (secs < 30) return "live"
  if (secs < 120) return "stale"
  return "dead"
}
