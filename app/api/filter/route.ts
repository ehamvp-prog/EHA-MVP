import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { validateCapture, daysSince } from "@/lib/filter/health"

export const dynamic = "force-dynamic"

const SITE_ID = "default"

type FilterEvent = {
  id: string
  site_id: string
  occurred_at: string
  floor_static_inwc: number
  fresh_static_inwc: number
  filter_drop_fresh_inwc: number
  note: string | null
}

// GET: the latest filter event (powers the gauge baseline + "days since
// change") plus the full list (audit/history; also the coil-fouling floor
// series for a future trend read).
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const siteId = searchParams.get("site_id") ?? SITE_ID
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from("filter_events")
      .select("*")
      .eq("site_id", siteId)
      .order("occurred_at", { ascending: false })
      .limit(100)
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })

    const events = (data ?? []) as FilterEvent[]
    const latest = events[0] ?? null
    return NextResponse.json({
      ok: true,
      latest,
      events,
      days_since_change: latest ? daysSince(latest.occurred_at) : null,
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    )
  }
}

// POST: record a calibration / filter-change event. Body carries the two
// captured static readings { floor_static_inwc, fresh_static_inwc, note? }.
// We validate, store the event (with the computed fresh drop), and ALSO log a
// human-visible row to automation_journal so the change shows in the system
// journal the homeowner already sees.
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const siteId: string = body.site_id ?? SITE_ID
    const floor = Number(body.floor_static_inwc)
    const fresh = Number(body.fresh_static_inwc)
    const note: string | null = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null

    const valid = validateCapture(floor, fresh)
    if (!valid.ok) {
      return NextResponse.json({ ok: false, error: valid.error }, { status: 400 })
    }

    const supabase = createAdminClient()

    const { data: inserted, error: insErr } = await supabase
      .from("filter_events")
      .insert({
        site_id: siteId,
        floor_static_inwc: Math.round(floor * 1000) / 1000,
        fresh_static_inwc: Math.round(fresh * 1000) / 1000,
        filter_drop_fresh_inwc: valid.drop,
        note,
      })
      .select("*")
      .maybeSingle()
    if (insErr) return NextResponse.json({ ok: false, error: insErr.message }, { status: 500 })

    // Visible record in the system journal (best-effort; don't fail the
    // calibration if the journal insert has trouble).
    await supabase
      .from("automation_journal")
      .insert({
        site_id: siteId,
        occurred_at: new Date().toISOString(),
        action_type: "filter_change",
        trigger_reason: `Filter calibrated — fresh-filter drop ${valid.drop.toFixed(2)}" WC (baseline ${floor.toFixed(2)}" WC)${note ? ` · ${note}` : ""}`,
        command_sent: null,
        nest_confirmed: null,
        before_state: null,
      })
      .then(
        () => {},
        () => {},
      )

    return NextResponse.json({ ok: true, event: inserted })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    )
  }
}
