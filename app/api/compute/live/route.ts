// =====================================================================
// GET /api/compute/live
// Computes live efficiency from the latest reading per device + the
// installer profile. Does NOT persist (display only). Persistence at a
// locked sample interval is Phase 7.
// =====================================================================

import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { runEngine, type SystemProfileInputs } from "@/lib/engine"
import type { LatestDevice } from "@/lib/engine/extract"
import { getWeatherByLatLon } from "@/lib/weather"

export const dynamic = "force-dynamic"

const SITE_ID = "default"

export async function GET() {
  try {
    const supabase = createAdminClient()

    // Latest profile
    const { data: profile } = await supabase
      .from("system_profile")
      .select("*")
      .eq("site_id", SITE_ID)
      .maybeSingle()

    // Recent telemetry, then reduce to the latest row per device.
    const { data: rows, error } = await supabase
      .from("telemetry")
      .select("device_id, device_type, payload, recorded_at, received_at")
      .eq("site_id", SITE_ID)
      .order("received_at", { ascending: false })
      .limit(500)

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    }

    const latestByDevice = new Map<string, LatestDevice>()
    for (const r of rows ?? []) {
      if (!latestByDevice.has(r.device_id)) {
        latestByDevice.set(r.device_id, r as LatestDevice)
      }
    }
    const devices = Array.from(latestByDevice.values())

    // Pull live outdoor conditions (internal) from the home's saved lat/lon.
    // These replace the old hand-entered barometric anchor AND feed the
    // anomaly layer (outdoor-temperature conditioning + confidence weighting).
    let liveBarometricInHg: number | null = null
    let outdoorTempF: number | null = null
    let weatherConfidence: "high" | "medium" | "low" | null = null
    const lat = (profile as { weather_lat?: number | null } | null)?.weather_lat
    const lon = (profile as { weather_lon?: number | null } | null)?.weather_lon
    if (typeof lat === "number" && typeof lon === "number") {
      const weather = await getWeatherByLatLon(lat, lon)
      if (weather.ok) {
        liveBarometricInHg = weather.outdoor_pressure_inhg
        outdoorTempF = weather.outdoor_temp_f
        weatherConfidence = weather.weather_confidence
      }
    }

    // Rolling healthy baseline: recent computed readings with a usable EER.
    // The engine bins these by outdoor temperature near the current value.
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

    const result = runEngine(devices, (profile as SystemProfileInputs) ?? null, {
      liveBarometricInHg,
      outdoorTempF,
      weatherConfidence,
      baselineSamples,
    })

    return NextResponse.json({
      ok: true,
      hasProfile: !!profile,
      deviceCount: devices.length,
      computed: result,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
