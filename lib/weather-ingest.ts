// =====================================================================
// Weather ingest — fills weather_observations with REAL historical weather
// from Open-Meteo (free, no key, dense hourly, no 7-day retention limit).
//
// Two uses:
//   • Historical backfill (one-off, explicit [from, to)).
//   • Rolling self-heal (called every automation tick) so weather keeps
//     getting logged going forward and any recent gap is repaired.
//
// Location comes from system_profile (weather_lat/lon, set from the ZIP in
// Settings). The live dashboard still reads the nearest NWS station for its
// "current conditions" chip; this job is specifically the historical record
// that powers outdoor_hourly / the efficiency overlay.
// =====================================================================

import { createAdminClient } from "@/lib/supabase/admin"
import { SITE_ID } from "@/lib/compute-reading"
import { getOpenMeteoHourly } from "@/lib/weather"

const DAY_MS = 24 * 60 * 60 * 1000

export type IngestResult = {
  ok: boolean
  error?: string
  from?: string
  to?: string
  hoursUpserted?: number
}

// UTC calendar date (YYYY-MM-DD) for an epoch ms — Open-Meteo's date params.
function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

// Ingest real hourly weather into weather_observations for [from, to).
export async function ingestWeather(opts?: {
  from?: string | Date
  to?: string | Date
  siteId?: string
}): Promise<IngestResult> {
  const siteId = opts?.siteId ?? SITE_ID
  const supabase = createAdminClient()

  // Default window: rolling last 3 days (self-healing) through now.
  const toMs = opts?.to ? new Date(opts.to).getTime() : Date.now()
  const fromMs = opts?.from ? new Date(opts.from).getTime() : toMs - 3 * DAY_MS
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
    return { ok: false, error: "Invalid ingest window" }
  }

  // Location from the profile (set by the ZIP entered in Settings).
  const { data: profile, error: profErr } = await supabase
    .from("system_profile")
    .select("weather_lat, weather_lon")
    .eq("site_id", siteId)
    .maybeSingle()
  if (profErr) return { ok: false, error: `profile read failed: ${profErr.message}` }

  const lat = (profile as { weather_lat?: number | null } | null)?.weather_lat ?? null
  const lon = (profile as { weather_lon?: number | null } | null)?.weather_lon ?? null
  if (lat == null || lon == null) {
    return { ok: false, error: "No weather location saved. Set your ZIP in Settings first." }
  }

  const res = await getOpenMeteoHourly(Number(lat), Number(lon), utcDate(fromMs), utcDate(toMs))
  if (!res.ok) return { ok: false, error: res.error ?? "weather fetch failed" }

  // Keep only hours within the requested window (Open-Meteo returns whole days).
  const nowMs = Date.now()
  const hours = res.hours.filter((h) => {
    const t = new Date(h.hour_utc).getTime()
    return t >= fromMs && t <= toMs && t <= nowMs
  })
  if (hours.length === 0) {
    return { ok: true, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), hoursUpserted: 0 }
  }

  const nowISO = new Date().toISOString()
  const rows = hours.map((h) => ({
    hour_utc: h.hour_utc,
    outdoor_temp_f: h.outdoor_temp_f,
    outdoor_rh: h.outdoor_rh,
    samples: h.samples,
    station_id: null,
    source: "Open-Meteo",
    updated_at: nowISO,
  }))

  let upserted = 0
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500)
    const { error } = await supabase.from("weather_observations").upsert(batch, { onConflict: "hour_utc" })
    if (error) return { ok: false, error: `upsert failed: ${error.message}`, hoursUpserted: upserted }
    upserted += batch.length
  }

  return {
    ok: true,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    hoursUpserted: upserted,
  }
}
