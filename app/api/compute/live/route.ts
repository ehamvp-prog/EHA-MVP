// =====================================================================
// GET /api/compute/live
// Computes live efficiency from the latest reading per device + the
// installer profile. Does NOT persist (display only). Persistence at a
// locked sample interval is Phase 7.
// =====================================================================

import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { runEngine, type SystemProfileInputs } from "@/lib/engine"
import type { LatestDevice } from "@/lib/engine/extract"

export const dynamic = "force-dynamic"

const SITE_ID = "default"

export async function GET() {
  try {
    const supabase = createAdminClient()

    // Latest profile
    const { data: profile } = await supabase
      .from("system_profile")
      .select("*")
      .eq("site_id", SITE_ID)
      .maybeSingle()

    // Recent telemetry, then reduce to the latest row per device.
    const { data: rows, error } = await supabase
      .from("telemetry")
      .select("device_id, device_type, payload, recorded_at, received_at")
      .eq("site_id", SITE_ID)
      .order("received_at", { ascending: false })
      .limit(500)

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    }

    const latestByDevice = new Map<string, LatestDevice>()
    for (const r of rows ?? []) {
      if (!latestByDevice.has(r.device_id)) {
        latestByDevice.set(r.device_id, r as LatestDevice)
      }
    }
    const devices = Array.from(latestByDevice.values())

    const result = runEngine(devices, (profile as SystemProfileInputs) ?? null)

    return NextResponse.json({
      ok: true,
      hasProfile: !!profile,
      deviceCount: devices.length,
      computed: result,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
