import { NextResponse } from "next/server"
import {
  fetchThermostat,
  getFreshAccessToken,
  nestConfigured,
  cacheHvacStatus,
  NestAuthError,
  NestRateLimitError,
} from "@/lib/nest/client"

export const dynamic = "force-dynamic"

// Server-side only. Reads the stored refresh token, mints a fresh access
// token, calls the SDM API, and returns thermostat state. The client polls
// this at most every 5 minutes (see the Nest card SWR config).
export async function GET() {
  if (!nestConfigured()) {
    return NextResponse.json({ ok: true, configured: false, connected: false, thermostat: null })
  }

  try {
    const accessToken = await getFreshAccessToken()
    if (!accessToken) {
      return NextResponse.json({ ok: true, configured: true, connected: false, thermostat: null })
    }
    const thermostat = await fetchThermostat(accessToken)
    // Cache the on/off mode so the compute engine can use it as the
    // authoritative run-state without making its own SDM call every tick.
    if (thermostat?.hvacStatus) await cacheHvacStatus(thermostat.hvacStatus)
    return NextResponse.json({ ok: true, configured: true, connected: true, thermostat })
  } catch (err) {
    if (err instanceof NestAuthError) {
      // Token revoked/invalid — surface a needsReconnect flag for the UI.
      return NextResponse.json({
        ok: true,
        configured: true,
        connected: false,
        needsReconnect: true,
        thermostat: null,
      })
    }
    if (err instanceof NestRateLimitError) {
      return NextResponse.json(
        { ok: false, configured: true, connected: true, error: "rate_limited", thermostat: null },
        { status: 429 },
      )
    }
    console.log("[v0] Nest data route error:", err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: false, error: "nest_data_failed" }, { status: 500 })
  }
}
