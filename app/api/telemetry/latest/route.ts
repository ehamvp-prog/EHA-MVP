import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

// Returns:
//  - devices: latest payload per device_id (for the gauges/tiles)
//  - history: most recent raw rows across all devices (for the feed)
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const siteId = searchParams.get("site_id") ?? "default"
  const historyLimit = Math.min(Number(searchParams.get("history") ?? 40), 200)

  try {
    const supabase = createAdminClient()

    // Pull a recent window, newest first. We derive "latest per device" in code.
    const { data, error } = await supabase
      .from("telemetry")
      .select("id, device_id, device_type, site_id, recorded_at, received_at, payload")
      .eq("site_id", siteId)
      .order("received_at", { ascending: false })
      .limit(500)

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    }

    const rows = data ?? []

    const latestByDevice = new Map<string, (typeof rows)[number]>()
    for (const row of rows) {
      if (!latestByDevice.has(row.device_id)) {
        latestByDevice.set(row.device_id, row)
      }
    }

    return NextResponse.json({
      ok: true,
      fetched_at: new Date().toISOString(),
      devices: Array.from(latestByDevice.values()),
      history: rows.slice(0, historyLimit),
      total_recent: rows.length,
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    )
  }
}
