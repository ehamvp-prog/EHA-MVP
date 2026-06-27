import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { geocodeZip } from "@/lib/weather"

export const dynamic = "force-dynamic"

// GET: read the currently saved weather location (from system_profile).
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const siteId = searchParams.get("site_id") ?? "default"

  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from("system_profile")
      .select("site_id, weather_zip, weather_lat, weather_lon, weather_station_id, weather_source")
      .eq("site_id", siteId)
      .maybeSingle()

    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, location: data ?? null })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    )
  }
}

// POST: save a temporary weather location by ZIP code.
// This is a stopgap until the full installer setup (Phase 2).
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const siteId: string = body.site_id ?? "default"
    const zip: string = String(body.zip ?? "").trim()

    if (!/^\d{5}$/.test(zip)) {
      return NextResponse.json(
        { ok: false, error: "Please enter a valid 5-digit US ZIP code." },
        { status: 400 },
      )
    }

    const geo = await geocodeZip(zip)
    if (!geo) {
      return NextResponse.json(
        { ok: false, error: "Could not find that ZIP code. Double-check it and try again." },
        { status: 400 },
      )
    }

    const supabase = createAdminClient()
    // Upsert the single home profile row, keyed by site_id.
    const { error } = await supabase.from("system_profile").upsert(
      {
        site_id: siteId,
        weather_zip: zip,
        weather_lat: geo.lat,
        weather_lon: geo.lon,
        weather_source: "NWS",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "site_id" },
    )

    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })

    return NextResponse.json({
      ok: true,
      location: { zip, lat: geo.lat, lon: geo.lon, city: geo.city, state: geo.state },
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    )
  }
}
