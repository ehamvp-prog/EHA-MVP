import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

// GET: recent automation journal rows (reverse chronological) for the
// "What we did for you" card. The automation engine writes rows server-side.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const siteId = searchParams.get("site_id") ?? "default"
  try {
    const supabase = createAdminClient()
    const { data, error } = await supabase
      .from("automation_journal")
      .select("*")
      .eq("site_id", siteId)
      .order("occurred_at", { ascending: false })
      .limit(500)
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, entries: data ?? [] })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    )
  }
}
