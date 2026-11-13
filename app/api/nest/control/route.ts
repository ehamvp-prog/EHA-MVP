import { NextResponse } from "next/server"
import {
  applyControl,
  fetchThermostat,
  getFreshAccessToken,
  nestConfigured,
  NestAuthError,
  NestRateLimitError,
  MAX_FAN_MINUTES,
  type ControlInput,
} from "@/lib/nest/client"
import { createAdminClient } from "@/lib/supabase/admin"
import { comfortContext } from "@/lib/comfort/load"
import { modeTargets, MIN_BAND_F } from "@/lib/comfort/targets"

export const dynamic = "force-dynamic"

const MODES = ["HEAT", "COOL", "HEATCOOL", "OFF"] as const
const FAN_MODES = ["ON", "AUTO"] as const

// Server-side only. Validates the requested change, sends the SDM command,
// and returns the refreshed thermostat state so the UI updates immediately.
export async function POST(req: Request) {
  if (!nestConfigured()) {
    return NextResponse.json({ ok: false, error: "Nest is not configured." }, { status: 503 })
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const input: ControlInput = {}
  if (body.mode != null) {
    if (!MODES.includes(body.mode as (typeof MODES)[number])) {
      return NextResponse.json({ ok: false, error: "Invalid mode" }, { status: 400 })
    }
    input.mode = body.mode as ControlInput["mode"]
  }
  if (body.heatSetpoint != null) {
    const v = Number(body.heatSetpoint)
    if (!Number.isFinite(v) || v < 45 || v > 95) {
      return NextResponse.json({ ok: false, error: "heatSetpoint out of range" }, { status: 400 })
    }
    input.heatSetpointF = v
  }
  if (body.coolSetpoint != null) {
    const v = Number(body.coolSetpoint)
    if (!Number.isFinite(v) || v < 45 || v > 95) {
      return NextResponse.json({ ok: false, error: "coolSetpoint out of range" }, { status: 400 })
    }
    input.coolSetpointF = v
  }
  if (body.fanMode != null) {
    if (!FAN_MODES.includes(body.fanMode as (typeof FAN_MODES)[number])) {
      return NextResponse.json({ ok: false, error: "Invalid fanMode" }, { status: 400 })
    }
    input.fanMode = body.fanMode as ControlInput["fanMode"]
  }
  if (body.fanMinutes != null) {
    const m = Number(body.fanMinutes)
    if (!Number.isFinite(m) || m < 1 || m > MAX_FAN_MINUTES) {
      return NextResponse.json({ ok: false, error: "fanMinutes out of range" }, { status: 400 })
    }
    input.fanMinutes = Math.round(m)
  }

  // Switching to Auto: start from the household's heat and cool targets (day or
  // sleep) so the Nest changes over between the numbers they chose.
  if (input.mode === "HEATCOOL" && input.heatSetpointF == null && input.coolSetpointF == null) {
    try {
      const { data: p } = await createAdminClient()
        .from("comfort_profile")
        .select("*")
        .eq("site_id", "default")
        .maybeSingle()
      if (p) {
        const sleepOn = p.sleep_enabled !== false
        const ctx = comfortContext({
          blowerOn: false,
          sleep: sleepOn ? { start: String(p.sleep_start ?? "22:00").slice(0, 5), end: String(p.sleep_end ?? "06:00").slice(0, 5) } : null,
        })
        const t = modeTargets(p, !!(sleepOn && ctx.night))
        input.heatSetpointF = t.heat
        input.coolSetpointF = t.cool
      }
    } catch {
      // No profile — the Nest keeps its own range.
    }
  }
  if (
    input.heatSetpointF != null &&
    input.coolSetpointF != null &&
    input.coolSetpointF < input.heatSetpointF + MIN_BAND_F
  ) {
    return NextResponse.json(
      { ok: false, error: `Cool must be at least ${MIN_BAND_F}°F above heat` },
      { status: 400 },
    )
  }

  if (Object.keys(input).length === 0) {
    return NextResponse.json({ ok: false, error: "No control changes provided" }, { status: 400 })
  }

  try {
    const accessToken = await getFreshAccessToken()
    if (!accessToken) {
      return NextResponse.json({ ok: false, error: "not_connected" }, { status: 401 })
    }
    await applyControl(accessToken, input)
    const thermostat = await fetchThermostat(accessToken)
    return NextResponse.json({ ok: true, thermostat })
  } catch (err) {
    if (err instanceof NestAuthError) {
      return NextResponse.json({ ok: false, error: "needs_reconnect" }, { status: 401 })
    }
    if (err instanceof NestRateLimitError) {
      return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 })
    }
    console.log("[v0] Nest control route error:", err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: false, error: "nest_control_failed" }, { status: 500 })
  }
}
