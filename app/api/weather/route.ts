import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { getWeatherByLatLon } from "@/lib/weather"

export const dynamic = "force-dynamic"

// Reads the saved home location from system_profile, then fetches the
// latest outdoor observation from the National Weather Service.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const siteId = searchParams.get("site_id") ?? "default"

  try {
    const supabase = createAdminClient()
    const { data: profile, error } = await supabase
      .from("system_profile")
      .select("weather_lat, weather_lon, weather_zip")
      .eq("site_id", siteId)
      .maybeSingle()

    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })

    const lat = profile?.weather_lat
    const lon = profile?.weather_lon
    if (lat == null || lon == null) {
      return NextResponse.json({
        ok: false,
        needs_location: true,
        error: "No weather location set yet. Add a ZIP code to start outdoor readings.",
      })
    }

    const weather = await getWeatherByLatLon(Number(lat), Number(lon))
    return NextResponse.json({ ok: weather.ok, fetched_at: new Date().toISOString(), weather })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    )
  }
}
