import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { learnedTargetFromCaptures, type Capture } from "@/lib/comfort/ring"

export const dynamic = "force-dynamic"

// GET: the auditable capture log + the current learned target derived from it.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const siteId = searchParams.get("site_id") ?? "default"
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from("comfort_captures")
      .select("id, captured_at, temp_f, rh, source")
      .eq("site_id", siteId)
      .order("captured_at", { ascending: false })
      .limit(100)
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    const captures = data ?? []
    const learned = learnedTargetFromCaptures(captures as Capture[])
    return NextResponse.json({ ok: true, captures, learned })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    )
  }
}

// DELETE: undo the most recent capture (e.g. the user tapped "I'm perfectly
// comfortable" by accident). Removes the newest row, then recomputes the
// learned target from whatever captures remain and writes it back.
export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const siteId = searchParams.get("site_id") ?? "default"
    const supabase = createAdminClient()

    // Find the most recent capture for this site.
    const { data: latest, error: findErr } = await supabase
      .from("comfort_captures")
      .select("id")
      .eq("site_id", siteId)
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (findErr) return NextResponse.json({ ok: false, error: findErr.message }, { status: 500 })
    if (!latest) {
      return NextResponse.json({ ok: false, error: "Nothing to undo." }, { status: 400 })
    }

    const { error: delErr } = await supabase.from("comfort_captures").delete().eq("id", latest.id)
    if (delErr) return NextResponse.json({ ok: false, error: delErr.message }, { status: 500 })

    // Recompute the learned target from the remaining captures.
    const { data: rows, error: selErr } = await supabase
      .from("comfort_captures")
      .select("captured_at, temp_f, rh")
      .eq("site_id", siteId)
    if (selErr) return NextResponse.json({ ok: false, error: selErr.message }, { status: 500 })

    const learned = learnedTargetFromCaptures((rows ?? []) as Capture[])
    // If captures remain, write the recomputed target back. If none remain,
    // leave the profile's preferred values untouched (nothing to learn from).
    if (learned) {
      const { error: upErr } = await supabase
        .from("comfort_profile")
        .upsert(
          {
            site_id: siteId,
            preferred_temp_f: Math.round(learned.tempF),
            preferred_rh: Math.round(learned.rh),
            updated_at: new Date().toISOString(),
          },
          { onConflict: "site_id" },
        )
      if (upErr) return NextResponse.json({ ok: false, error: upErr.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true, learned, remaining: rows?.length ?? 0 })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    )
  }
}

// POST: record a "perfectly comfortable right now" capture. Appends to the
// auditable log, recomputes the ~30-day half-life weighted target across ALL
// captures, and writes that learned target into comfort_profile.preferred_*.
// The learned target is the single source of truth the ring + automation read.
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const siteId: string = body.site_id ?? "default"
    const tempF = Number(body.temp_f)
    const rh = Number(body.rh)
    const source = body.source === "nest" ? "nest" : "sensor"

    if (!Number.isFinite(tempF) || !Number.isFinite(rh)) {
      return NextResponse.json(
        { ok: false, error: "No live temperature/humidity available to capture." },
        { status: 400 },
      )
    }

    const supabase = createAdminClient()

    // 1. Append the capture to the auditable log.
    const { error: insErr } = await supabase.from("comfort_captures").insert({
      site_id: siteId,
      temp_f: tempF,
      rh,
      source,
    })
    if (insErr) return NextResponse.json({ ok: false, error: insErr.message }, { status: 500 })

    // 2. Recompute the weighted learned target across all captures.
    const { data: rows, error: selErr } = await supabase
      .from("comfort_captures")
      .select("captured_at, temp_f, rh")
      .eq("site_id", siteId)
    if (selErr) return NextResponse.json({ ok: false, error: selErr.message }, { status: 500 })

    const learned = learnedTargetFromCaptures((rows ?? []) as Capture[])
    if (!learned) {
      return NextResponse.json({ ok: false, error: "Could not compute target." }, { status: 500 })
    }

    // 3. Write the learned target back as the effective preferred conditions.
    const { data: profile, error: upErr } = await supabase
      .from("comfort_profile")
      .upsert(
        {
          site_id: siteId,
          preferred_temp_f: Math.round(learned.tempF),
          preferred_rh: Math.round(learned.rh),
          anchor_temp_f: tempF,
          anchor_rh: rh,
          anchor_set_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "site_id" },
      )
      .select("*")
      .maybeSingle()
    if (upErr) return NextResponse.json({ ok: false, error: upErr.message }, { status: 500 })

    return NextResponse.json({ ok: true, profile, learned })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    )
  }
}
