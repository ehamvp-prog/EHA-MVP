// =====================================================================
// Shared live-compute pipeline used by BOTH the display route
// (/api/compute/live) and the persistence route (/api/compute/persist).
// Keeping this in one place guarantees the number you SEE is the exact
// number that gets SAVED.
// =====================================================================

import { createAdminClient } from "@/lib/supabase/admin"
import { runEngine, type SystemProfileInputs, type ComputedReading } from "@/lib/engine"
import { extractHvacInputs, type LatestDevice, type HvacInputs } from "@/lib/engine/extract"
import { getWeatherByLatLon, type WeatherResult } from "@/lib/weather"
import { nestConfigured, getCachedHvacStatus, getCachedThermostatMode } from "@/lib/nest/client"
import type { FurnaceStage, FurnaceSignature } from "@/lib/engine/heating/furnace-sequence"
import type { SeasonMode, ThermostatMode } from "@/lib/engine/heating/operating-mode"

export const SITE_ID = "default"

// system_profile.furnace_signature is jsonb. Accept it only when every value
// is a finite number; otherwise return null so the engine uses the default.
function parseFurnaceSignature(raw: unknown): FurnaceSignature | null {
  const obj = typeof raw === "string" ? safeJson(raw) : raw
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null
  const entries = Object.entries(obj as Record<string, unknown>)
  if (entries.length === 0) return null
  if (!entries.every(([, v]) => typeof v === "number" && Number.isFinite(v))) return null
  return obj as FurnaceSignature
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

export interface ComputeBundle {
  hasProfile: boolean
  deviceCount: number
  inputs: HvacInputs
  weather: WeatherResult | null
  computed: ComputedReading
  readingAt: string
}

/**
 * Runs the full pipeline: profile -> latest telemetry per device ->
 * live weather -> temperature-conditioned baseline -> engine.
 * Pure read; performs no writes.
 */
export async function computeLiveReading(): Promise<ComputeBundle> {
  const supabase = createAdminClient()
  const readingAt = new Date().toISOString()

  const { data: profile } = await supabase
    .from("system_profile")
    .select("*")
    .eq("site_id", SITE_ID)
    .maybeSingle()

  const { data: rows, error } = await supabase
    .from("telemetry")
    .select("device_id, device_type, payload, recorded_at, received_at")
    .eq("site_id", SITE_ID)
    .order("received_at", { ascending: false })
    .limit(500)

  if (error) throw new Error(error.message)

  const latestByDevice = new Map<string, LatestDevice>()
  for (const r of rows ?? []) {
    if (!latestByDevice.has(r.device_id)) {
      latestByDevice.set(r.device_id, r as LatestDevice)
    }
  }
  const devices = Array.from(latestByDevice.values())
  const inputs = extractHvacInputs(devices)

  // Live outdoor conditions (internal) from the home's saved lat/lon.
  let weather: WeatherResult | null = null
  const lat = (profile as { weather_lat?: number | null } | null)?.weather_lat
  const lon = (profile as { weather_lon?: number | null } | null)?.weather_lon
  if (typeof lat === "number" && typeof lon === "number") {
    const w = await getWeatherByLatLon(lat, lon)
    if (w.ok) weather = w
  }

  // Rolling healthy baseline: recent computed readings with a usable EER.
  const { data: history } = await supabase
    .from("computed_readings")
    .select("outdoor_temp_f, live_eer")
    .eq("site_id", SITE_ID)
    .not("live_eer", "is", null)
    .order("reading_at", { ascending: false })
    .limit(2000)

  const baselineSamples = (history ?? []).map((h) => ({
    outdoorTempF: h.outdoor_temp_f as number | null,
    liveEer: h.live_eer as number | null,
  }))

  // Previous reading's coil delta-T and static, used to detect a DECAYING
  // (off-cycle) trend so residual coil cooling is not flagged as a fault.
  const { data: prevRow } = await supabase
    .from("computed_readings")
    .select("return_temp_f, supply_temp_f, static_pressure_inwc, furnace_stage, season_mode")
    .eq("site_id", SITE_ID)
    .order("reading_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  const prevReturn = (prevRow?.return_temp_f as number | null) ?? null
  const prevSupply = (prevRow?.supply_temp_f as number | null) ?? null
  const prevCoolingDeltaF =
    prevReturn != null && prevSupply != null ? prevReturn - prevSupply : null
  const prevRiseF =
    prevReturn != null && prevSupply != null ? prevSupply - prevReturn : null
  const prevStaticInWc = (prevRow?.static_pressure_inwc as number | null) ?? null
  const prevFurnaceStage = (prevRow?.furnace_stage as FurnaceStage | null) ?? null
  const prevSeasonMode = (prevRow?.season_mode as SeasonMode | null) ?? null

  const furnaceSignature = parseFurnaceSignature(
    (profile as { furnace_signature?: unknown } | null)?.furnace_signature,
  )

  // Authoritative thermostat on/off mode, read from the fresh cache only
  // (no SDM API call here — keeps Nest out of the compute hot path).
  const hvacStatus = nestConfigured() ? await getCachedHvacStatus() : null
  const thermostatMode: ThermostatMode = nestConfigured()
    ? ((await getCachedThermostatMode()) as ThermostatMode)
    : null

  const computed = runEngine(devices, (profile as SystemProfileInputs) ?? null, {
    liveBarometricInHg: weather?.outdoor_pressure_inhg ?? null,
    outdoorTempF: weather?.outdoor_temp_f ?? null,
    weatherConfidence: weather?.weather_confidence ?? null,
    baselineSamples,
    readingAt,
    hvacStatus,
    prevCoolingDeltaF,
    prevStaticInWc,
    thermostatMode,
    prevFurnaceStage,
    prevSeasonMode,
    prevRiseF,
    furnaceSignature,
  })

  return {
    hasProfile: !!profile,
    deviceCount: devices.length,
    inputs,
    weather,
    computed,
    readingAt,
  }
}
