import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

// The four effective modes returned by current_automation_mode(). Derived from
// the three stored booleans; the DB CHECK constraint (mode_valid) is the source
// of truth for which combinations are legal.
export type AutomationMode = "manual" | "comfort" | "savings" | "balanced"

type Triple = { manual: boolean; comfort: boolean; savings: boolean }

// Resolve the human label the same way the SQL function does, so the client can
// render optimistically without a round-trip.
function modeFromTriple(t: Triple): AutomationMode {
  if (t.manual) return "manual"
  if (t.comfort && t.savings) return "balanced"
  if (t.comfort) return "comfort"
  if (t.savings) return "savings"
  return "balanced"
}

// GET: current toggle state + resolved mode for this home.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const siteId = searchParams.get("site_id") ?? "default"

  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from("automation_mode")
      .select("manual, comfort, savings")
      .eq("site_id", siteId)
      .maybeSingle()

    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })

    // No row yet → Balanced is the safe, non-empty default.
    const flags: Triple = data
      ? { manual: !!data.manual, comfort: !!data.comfort, savings: !!data.savings }
      : { manual: false, comfort: true, savings: true }

    return NextResponse.json({ ok: true, flags, mode: modeFromTriple(flags) })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    )
  }
}

// POST: set the toggle state. The client sends a fully-resolved triple; we upsert
// it and let the DB CHECK constraint reject illegal combinations (manual paired
// with another, or all-three-off). We surface that error instead of swallowing it.
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const siteId: string = body.site_id ?? "default"
    const flags: Triple = {
      manual: Boolean(body.manual),
      comfort: Boolean(body.comfort),
      savings: Boolean(body.savings),
    }

    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from("automation_mode")
      .upsert(
        { site_id: siteId, ...flags, updated_at: new Date().toISOString() },
        { onConflict: "site_id" },
      )
      .select("manual, comfort, savings")
      .maybeSingle()

    if (error) {
      // A constraint violation (23514) means an invalid combination slipped
      // through — reject with a 400 so the UI can revert and explain.
      const isCheck = (error as { code?: string }).code === "23514"
      return NextResponse.json(
        {
          ok: false,
          error: isCheck
            ? "That combination isn't allowed — Manual can't be paired with another mode, and at least one mode must stay on."
            : error.message,
        },
        { status: isCheck ? 400 : 500 },
      )
    }

    const saved: Triple = {
      manual: !!data?.manual,
      comfort: !!data?.comfort,
      savings: !!data?.savings,
    }
    return NextResponse.json({ ok: true, flags: saved, mode: modeFromTriple(saved) })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    )
  }
}
