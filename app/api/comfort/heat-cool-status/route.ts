// =====================================================================
// GET /api/comfort/heat-cool-status
// What the heat/cool automation is doing right now, in plain words: the
// latest decision the 5-minute brain logged (an action or a "holding" note).
// =====================================================================

import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { SITE_ID } from "@/lib/compute-reading"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const db = createAdminClient()
    const since = new Date(Date.now() - 3 * 3600_000).toISOString()
    const { data, error } = await db
      .from("automation_journal")
      .select("occurred_at, action_type, trigger_reason, command_sent")
      .eq("site_id", SITE_ID)
      .in("action_type", ["comfort_adjust", "evaluation", "recommendation"])
      .gte("occurred_at", since)
      .order("occurred_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(error.message)
    const cmd = (data?.command_sent ?? null) as Record<string, unknown> | null
    const text = data?.trigger_reason
      ? String(data.trigger_reason)
          .replace(/^Evaluated — /, "")
          .replace(/^\[[a-z_]+\]\s*/, "")
      : null
    return NextResponse.json({
      ok: true,
      at: data?.occurred_at ?? null,
      kind: data?.action_type ?? null,
      text,
      drying: cmd?.dry_rewarm === true || /^Drying:|Drying: AC/.test(text ?? ""),
    })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 })
  }
}
