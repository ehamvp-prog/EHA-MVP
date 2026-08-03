// One-off historical weather backfill via Open-Meteo (dense hourly, no 7-day
// limit). Mirrors lib/weather-ingest.ts but runs standalone so it doesn't
// depend on the dev server's env.
// Usage: node --env-file=/vercel/share/.env.project scripts/backfill-weather.mjs FROM_DATE TO_DATE
//   dates are YYYY-MM-DD (UTC), inclusive.
import { createClient } from "@supabase/supabase-js"

const SITE_ID = "default"
const sb = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
)

async function main() {
  const [, , fromDate, toDate] = process.argv
  const { data: prof } = await sb
    .from("system_profile")
    .select("weather_lat, weather_lon")
    .eq("site_id", SITE_ID)
    .maybeSingle()
  const lat = Number(prof.weather_lat)
  const lon = Number(prof.weather_lon)
  console.log("[v0] location", lat, lon, "range", fromDate, "->", toDate)

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m,relative_humidity_2m&temperature_unit=fahrenheit` +
    `&timezone=UTC&start_date=${fromDate}&end_date=${toDate}`
  const res = await fetch(url)
  if (!res.ok) { console.log("[v0] Open-Meteo failed", res.status); process.exit(1) }
  const j = await res.json()
  const times = j.hourly?.time ?? []
  const temps = j.hourly?.temperature_2m ?? []
  const rhs = j.hourly?.relative_humidity_2m ?? []

  const nowMs = Date.now()
  const nowISO = new Date().toISOString()
  const rows = []
  for (let i = 0; i < times.length; i++) {
    const t = temps[i], rh = rhs[i]
    if (t == null && rh == null) continue
    const hour_utc = new Date(`${times[i]}:00Z`).toISOString()
    if (new Date(hour_utc).getTime() > nowMs) continue // never write the future
    rows.push({
      hour_utc,
      outdoor_temp_f: t != null ? Math.round(t * 10) / 10 : null,
      outdoor_rh: rh != null ? Math.round(rh * 10) / 10 : null,
      samples: 1,
      station_id: null,
      source: "Open-Meteo",
      updated_at: nowISO,
    })
  }

  let up = 0
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500)
    const { error } = await sb.from("weather_observations").upsert(batch, { onConflict: "hour_utc" })
    if (error) { console.log("[v0] upsert error", error.message); process.exit(1) }
    up += batch.length
  }
  console.log("[v0] DONE upserted", up, "hours")
}
main().catch((e) => { console.log("[v0] ERR", e.message); process.exit(1) })
