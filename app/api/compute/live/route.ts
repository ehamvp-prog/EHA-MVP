// =====================================================================
// GET /api/compute/live
// Computes live efficiency from the latest reading per device + the
// installer profile, using the shared compute pipeline. Display only —
// does NOT persist. Persistence happens in /api/compute/persist.
// =====================================================================

import { NextResponse } from "next/server"
import { computeLiveReading } from "@/lib/compute-reading"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const bundle = await computeLiveReading()
    return NextResponse.json({
      ok: true,
      hasProfile: bundle.hasProfile,
      deviceCount: bundle.deviceCount,
      computed: bundle.computed,
      weather: bundle.weather,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
