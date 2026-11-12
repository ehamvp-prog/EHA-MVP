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
  // Furnace (heating) commissioning
  "gas_type",
  "heat_blower_speed_tap",
] as const

const NUM_FIELDS = [
  "system_tonnage",
  "rated_seer2",
  "cfm_per_ton",
  "seer2_conversion_factor",
  // Automation tuning (installer-enrolled).
  "auto_comfort_temp_min_f",
  "auto_comfort_temp_max_f",
  "peak_dodger_precool_offset_f",
  "peak_dodger_coast_offset_f",
  // Furnace (heating) commissioning
  "gas_heating_value_btu_per_cuft",
  "gas_rate_override_per_mcf", // gas_rate_per_therm itself is derived by a DB trigger
  "furnace_stages",
  "furnace_input_nameplate_btuh",
  "furnace_input_low_fire_btuh",
  "furnace_input_high_fire_btuh",
  "furnace_afue_rated_pct",
  "furnace_rise_min_f",
  "furnace_rise_max_f",
  "heat_cfm",
  "supply_limit_f",
  "auto_heat_temp_min_f",
  "auto_heat_temp_max_f",
] as const

// Automation enrollment toggles. Default OFF — nothing actuates until enrolled.
const BOOL_FIELDS = [
  "auto_comfort_enabled",
  "auto_comfort_fan_enabled",
  "peak_dodger_enabled",
  "furnace_condensing",
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

    // gas_type has a CHECK constraint; anything else would fail the whole save.
    if ("gas_type" in update && update.gas_type != null && !["natural_gas", "propane"].includes(String(update.gas_type))) {
      return NextResponse.json({ ok: false, error: "Gas type must be natural gas or propane." }, { status: 400 })
    }
    if ("furnace_stages" in update && update.furnace_stages != null && ![1, 2].includes(Number(update.furnace_stages))) {
      return NextResponse.json({ ok: false, error: "Furnace stages must be 1 or 2." }, { status: 400 })
    }

    // Evergy RTOU confirmation checkbox.
    if ("evergy_rtou_confirmed" in body) {
      update.evergy_rtou_confirmed = Boolean(body.evergy_rtou_confirmed)
    }

    // Automation enrollment toggles.
    for (const f of BOOL_FIELDS) {
      if (f in body) update[f] = Boolean(body[f])
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
