import { NextResponse } from "next/server"
import { buildAuthUrl, clearTokens, nestConfigured, resolveOrigin } from "@/lib/nest/client"

export const dynamic = "force-dynamic"

// Starts the Google OAuth flow: redirects the browser to Google's Partner
// Connections authorization screen with the SDM scope. Pass ?reconnect=1 to
// first clear a dead/revoked token before restarting consent.
export async function GET(req: Request) {
  if (!nestConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Nest is not configured. Missing Google OAuth env vars." },
      { status: 503 },
    )
  }
  const url = new URL(req.url)
  if (url.searchParams.get("reconnect") === "1") {
    try {
      await clearTokens()
    } catch (err) {
      console.log("[v0] Nest reconnect clearTokens failed:", err instanceof Error ? err.message : err)
    }
  }
  const origin = resolveOrigin(req.url)
  return NextResponse.redirect(buildAuthUrl(origin))
}
