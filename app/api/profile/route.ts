import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { geocodeZip } from "@/lib/weather"

export const dynamic = "force-dynamic"

// Fields the installer can set. Everything is optional so partial saves work.
const TEXT_FIELDS = [
  "condenser_make",
  "condenser_model",
  "condenser_serial",
  "evaporator_coil_model",
  "metering_type",
  "equipment_class",
  "blower_type",
  "blower_model",
  "blower_speed_tap",
  "ecm_profile",
  "coil_state",
  "weather_station_id",
] as const

const NUM_FIELDS = [
  "system_tonnage",
  "barometric_pressure_inhg",
  "rated_seer2",
  "cfm_per_ton",
  "seer2_conversion_factor",
] as const

// GET: read the full installer profile for this home.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const siteId = searchParams.get("site_id") ?? "default"

  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from("system_profile")
      .select("*")
      .eq("site_id", siteId)
      .maybeSingle()

    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, profile: data ?? null })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    )
  }
}

// POST: save the installer profile. Upserts the single home row by site_id,
// so it merges with the weather location already stored in Phase 1.
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const siteId: string = body.site_id ?? "default"

    const update: Record<string, unknown> = {
      site_id: siteId,
      updated_at: new Date().toISOString(),
    }

    // Copy text fields through, trimming blanks to null.
    for (const f of TEXT_FIELDS) {
      if (f in body) {
        const v = String(body[f] ?? "").trim()
        update[f] = v === "" ? null : v
      }
    }

    // Copy numeric fields, coercing blanks/invalid to null.
    for (const f of NUM_FIELDS) {
      if (f in body) {
        const raw = body[f]
        const n = raw === "" || raw === null || raw === undefined ? null : Number(raw)
        update[f] = n === null || Number.isNaN(n) ? null : n
      }
    }

    // Evergy RTOU confirmation checkbox.
    if ("evergy_rtou_confirmed" in body) {
      update.evergy_rtou_confirmed = Boolean(body.evergy_rtou_confirmed)
    }

    // Weather ZIP: if provided, re-geocode so lat/lon stay in sync.
    if ("weather_zip" in body) {
      const zip = String(body.weather_zip ?? "").trim()
      if (zip !== "") {
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
        update.weather_zip = zip
        update.weather_lat = geo.lat
        update.weather_lon = geo.lon
        update.weather_source = "NWS"
      }
    }

    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from("system_profile")
      .upsert(update, { onConflict: "site_id" })
      .select("*")
      .maybeSingle()

    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, profile: data })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    )
  }
}
