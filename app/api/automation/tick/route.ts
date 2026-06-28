import { NextResponse } from "next/server"
import { runAutomationTick } from "@/lib/automation/engine"

export const dynamic = "force-dynamic"
export const maxDuration = 30

// Drives one automation evaluation. Called on a cadence from the client (like
// /api/compute/persist) since there is no server cron here. The engine itself
// enforces cooldowns, peak windows, the safety band, and once-per-day guards,
// so calling this more often than needed is safe and idempotent.
export async function POST() {
  try {
    const result = await runAutomationTick()
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    console.log("[v0] automation tick failed:", err instanceof Error ? err.message : err)
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "tick failed" },
      { status: 500 },
    )
  }
}
