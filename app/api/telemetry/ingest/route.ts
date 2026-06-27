import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"

// =====================================================================
// Telemetry ingest endpoint  ->  POST /api/telemetry/ingest
//
// This is the web address your Shelly scripts already POST to.
// Flow:
//   1. Check the "Authorization: Bearer <secret>" header.
//   2. Read the JSON body the device sent.
//   3. Save the WHOLE body, untouched, into the `telemetry` table.
//
// It does NOT do any HVAC math. It just stores raw readings.
// =====================================================================

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  // ---- 1) Check the secret ----------------------------------------
  const secret = process.env.TELEMETRY_INGEST_SECRET
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "Server is missing TELEMETRY_INGEST_SECRET." },
      { status: 500 }
    )
  }

  const authHeader = request.headers.get("authorization") ?? ""
  const provided = authHeader.replace(/^Bearer\s+/i, "").trim()
  if (provided !== secret) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized. Bad or missing Bearer secret." },
      { status: 401 }
    )
  }

  // ---- 2) Read the JSON body --------------------------------------
  let payload: Record<string, unknown>
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json(
      { ok: false, error: "Body was not valid JSON." },
      { status: 400 }
    )
  }

  const deviceId = typeof payload.device_id === "string" ? payload.device_id : null
  if (!deviceId) {
    return NextResponse.json(
      { ok: false, error: "Missing required field: device_id." },
      { status: 400 }
    )
  }

  const deviceType =
    typeof payload.device_type === "string" ? payload.device_type : null
  const siteId =
    typeof payload.site_id === "string" ? payload.site_id : "default"
  // Optional device-reported time. If absent, the DB defaults received_at = now().
  const recordedAt =
    typeof payload.recorded_at === "string" ? payload.recorded_at : null

  // ---- 3) Store the raw payload -----------------------------------
  try {
    const supabase = createAdminClient()
    const { error } = await supabase.from("telemetry").insert({
      device_id: deviceId,
      device_type: deviceType,
      site_id: siteId,
      recorded_at: recordedAt,
      payload, // full body stored as-is in the jsonb column
    })

    if (error) {
      console.log("[v0] telemetry insert error:", error.message)
      return NextResponse.json(
        { ok: false, error: "Could not save telemetry." },
        { status: 500 }
      )
    }
  } catch (err) {
    console.log("[v0] telemetry ingest exception:", (err as Error).message)
    return NextResponse.json(
      { ok: false, error: "Server error while saving telemetry." },
      { status: 500 }
    )
  }

  return NextResponse.json({ ok: true, stored: true, device_id: deviceId })
}

// A simple GET so you can confirm the endpoint exists in a browser.
export async function GET() {
  return NextResponse.json({
    ok: true,
    message: "EHA telemetry ingest is live. Send sensor data with POST.",
  })
}
