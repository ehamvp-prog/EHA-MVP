// =====================================================================
// Outdoor weather via the National Weather Service (NWS / NOAA).
// Free, no API key. Requires a descriptive User-Agent header.
// Flow: ZIP -> lat/lon -> nearest station -> latest observation.
// =====================================================================

const NWS_HEADERS = {
  "User-Agent": "ElevateHomeApp/1.0 (HVAC efficiency monitor)",
  Accept: "application/geo+json",
}

export type WeatherResult = {
  ok: boolean
  error?: string
  outdoor_temp_f: number | null
  outdoor_rh: number | null
  outdoor_pressure_inhg: number | null
  weather_source: string | null
  weather_station_id: string | null
  weather_obs_timestamp: string | null
  weather_obs_age_min: number | null
  weather_confidence: "high" | "medium" | "low" | null
  resolved_city?: string | null
  resolved_state?: string | null
}

function cToF(c: number | null): number | null {
  return c == null ? null : Math.round((c * 9) / 5 + 32)
}

function paToInHg(pa: number | null): number | null {
  return pa == null ? null : Math.round(pa * 0.0002953 * 100) / 100
}

// Turn a US ZIP into latitude/longitude using the free Zippopotam service.
export async function geocodeZip(
  zip: string,
): Promise<{ lat: number; lon: number; city: string; state: string } | null> {
  try {
    const res = await fetch(`https://api.zippopotam.us/us/${encodeURIComponent(zip)}`, {
      cache: "no-store",
    })
    if (!res.ok) return null
    const data = await res.json()
    const place = data?.places?.[0]
    if (!place) return null
    return {
      lat: Number(place.latitude),
      lon: Number(place.longitude),
      city: place["place name"],
      state: place["state abbreviation"],
    }
  } catch {
    return null
  }
}

// Standard-atmosphere station pressure (inHg) for a given elevation (meters).
// Used as a fallback ONLY when a live observation has no barometric reading.
// p = 29.92 * (1 - 2.25577e-5 * h)^5.25588
export function pressureFromElevationM(elevationM: number | null): number | null {
  if (elevationM == null || !Number.isFinite(elevationM)) return null
  const p = 29.92 * Math.pow(1 - 2.25577e-5 * elevationM, 5.25588)
  return Math.round(p * 100) / 100
}

function confidenceFromAge(ageMin: number | null): "high" | "medium" | "low" {
  if (ageMin == null) return "low"
  if (ageMin <= 75) return "high"
  if (ageMin <= 180) return "medium"
  return "low"
}

export type HourlyObs = {
  hour_utc: string // ISO, truncated to the hour
  outdoor_temp_f: number | null
  outdoor_rh: number | null
  samples: number
}

// Fetch dense, gap-free historical hourly weather from Open-Meteo (free, no key).
// Unlike the NWS observations endpoint — which only retains ~7 days — Open-Meteo
// serves complete hourly temperature + humidity for the whole requested range,
// so it is the source used to backfill and self-heal outdoor_hourly history.
// Dates are inclusive YYYY-MM-DD in UTC. Returns hours ascending.
export async function getOpenMeteoHourly(
  lat: number,
  lon: number,
  startDate: string,
  endDate: string,
): Promise<{ ok: boolean; error?: string; hours: HourlyObs[] }> {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&hourly=temperature_2m,relative_humidity_2m&temperature_unit=fahrenheit` +
      `&timezone=UTC&start_date=${startDate}&end_date=${endDate}`
    const res = await fetch(url, { cache: "no-store" })
    if (!res.ok) return { ok: false, error: `Open-Meteo failed (${res.status})`, hours: [] }
    const json = await res.json()
    const times: string[] = json?.hourly?.time ?? []
    const temps: (number | null)[] = json?.hourly?.temperature_2m ?? []
    const rhs: (number | null)[] = json?.hourly?.relative_humidity_2m ?? []

    const hours: HourlyObs[] = []
    for (let i = 0; i < times.length; i++) {
      const t = temps[i]
      const rh = rhs[i]
      if (t == null && rh == null) continue
      // Open-Meteo hourly timestamps are top-of-hour UTC ("YYYY-MM-DDTHH:MM").
      const hour_utc = new Date(`${times[i]}:00Z`).toISOString()
      hours.push({
        hour_utc,
        outdoor_temp_f: t != null ? Math.round(t * 10) / 10 : null,
        outdoor_rh: rh != null ? Math.round(rh * 10) / 10 : null,
        samples: 1, // modeled reanalysis: one authoritative value per hour
      })
    }
    return { ok: true, hours }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Open-Meteo fetch failed", hours: [] }
  }
}

// Given lat/lon, find the nearest NWS station and read the latest observation.
export async function getWeatherByLatLon(lat: number, lon: number): Promise<WeatherResult> {
  const empty: WeatherResult = {
    ok: false,
    outdoor_temp_f: null,
    outdoor_rh: null,
    outdoor_pressure_inhg: null,
    weather_source: null,
    weather_station_id: null,
    weather_obs_timestamp: null,
    weather_obs_age_min: null,
    weather_confidence: null,
  }

  try {
    // 1) points -> stations list URL
    const pointsRes = await fetch(
      `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
      { headers: NWS_HEADERS, cache: "no-store" },
    )
    if (!pointsRes.ok) return { ...empty, error: `NWS points lookup failed (${pointsRes.status})` }
    const points = await pointsRes.json()
    const stationsUrl: string | undefined = points?.properties?.observationStations
    const city = points?.properties?.relativeLocation?.properties?.city ?? null
    const state = points?.properties?.relativeLocation?.properties?.state ?? null
    if (!stationsUrl) return { ...empty, error: "No observation stations for this location" }

    // 2) first (nearest) station
    const stationsRes = await fetch(stationsUrl, { headers: NWS_HEADERS, cache: "no-store" })
    if (!stationsRes.ok) return { ...empty, error: "Could not list nearby stations" }
    const stations = await stationsRes.json()
    const station = stations?.features?.[0]
    const stationId: string | undefined = station?.properties?.stationIdentifier
    if (!stationId) return { ...empty, error: "No usable station found" }
    // Station elevation (meters) — used for the pressure fallback below.
    const stationElevationM: number | null =
      typeof station?.properties?.elevation?.value === "number"
        ? station.properties.elevation.value
        : null

    // 3) latest observation
    const obsRes = await fetch(
      `https://api.weather.gov/stations/${stationId}/observations/latest`,
      { headers: NWS_HEADERS, cache: "no-store" },
    )
    if (!obsRes.ok) return { ...empty, error: "No recent observation available" }
    const obs = await obsRes.json()
    const p = obs?.properties ?? {}

    const tempF = cToF(p.temperature?.value ?? null)
    const rh = p.relativeHumidity?.value != null ? Math.round(p.relativeHumidity.value) : null
    // Prefer the live observed station pressure; if absent, derive it from
    // the station's elevation using the standard atmosphere. Both are internal.
    const pressureInHg =
      paToInHg(p.barometricPressure?.value ?? p.seaLevelPressure?.value ?? null) ??
      pressureFromElevationM(stationElevationM)
    const obsTimestamp: string | null = p.timestamp ?? null
    const ageMin =
      obsTimestamp != null
        ? Math.max(0, Math.round((Date.now() - new Date(obsTimestamp).getTime()) / 60000))
        : null

    return {
      ok: true,
      outdoor_temp_f: tempF,
      outdoor_rh: rh,
      outdoor_pressure_inhg: pressureInHg,
      weather_source: "NWS",
      weather_station_id: stationId,
      weather_obs_timestamp: obsTimestamp,
      weather_obs_age_min: ageMin,
      weather_confidence: confidenceFromAge(ageMin),
      resolved_city: city,
      resolved_state: state,
    }
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : "Unknown weather error" }
  }
}
