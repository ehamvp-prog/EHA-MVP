import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const AGE_GROUPS = new Set(["young_adults", "adults", "seniors", "mixed"])
const ACTIVITY = new Set(["sedentary", "moderate", "active"])
const HEALTH = new Set([
  "asthma",
  "allergies",
  "copd",
  "arthritis",
  "migraines",
  "skin_sensitivity",
  "sleep_issues",
])

// GET: read the comfort profile for this home.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const siteId = searchParams.get("site_id") ?? "default"
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from("comfort_profile")
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

// POST: save the comfort profile (upsert single row by site_id).
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const siteId: string = body.site_id ?? "default"
    const update: Record<string, unknown> = {
      site_id: siteId,
      updated_at: new Date().toISOString(),
    }

    if ("preferred_temp_f" in body) {
      const n = Number(body.preferred_temp_f)
      if (!Number.isNaN(n)) update.preferred_temp_f = Math.min(80, Math.max(60, n))
    }
    if ("preferred_rh" in body) {
      const n = Number(body.preferred_rh)
      if (!Number.isNaN(n)) update.preferred_rh = Math.min(70, Math.max(20, n))
    }
    if ("age_group" in body && AGE_GROUPS.has(body.age_group)) update.age_group = body.age_group
    if ("activity_level" in body && ACTIVITY.has(body.activity_level)) {
      update.activity_level = body.activity_level
    }
    if ("household_size" in body) {
      const n = Number(body.household_size)
      if (!Number.isNaN(n)) update.household_size = Math.min(6, Math.max(1, Math.round(n)))
    }
    if ("health_considerations" in body && Array.isArray(body.health_considerations)) {
      update.health_considerations = body.health_considerations
        .map((h: unknown) => String(h).toLowerCase())
        .filter((h: string) => HEALTH.has(h))
    }

    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from("comfort_profile")
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

// PATCH: Training Mode anchor — capture the current felt-perfect conditions as
// the new preferred temp/humidity (and record the anchor timestamp).
export async function PATCH(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const siteId: string = body.site_id ?? "default"
    const temp = Number(body.anchor_temp_f)
    const rh = Number(body.anchor_rh)
    if (Number.isNaN(temp) || Number.isNaN(rh)) {
      return NextResponse.json(
        { ok: false, error: "No live temperature/humidity available to anchor." },
        { status: 400 },
      )
    }

    const update = {
      site_id: siteId,
      preferred_temp_f: Math.round(temp),
      preferred_rh: Math.round(rh),
      anchor_temp_f: temp,
      anchor_rh: rh,
      anchor_set_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from("comfort_profile")
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
