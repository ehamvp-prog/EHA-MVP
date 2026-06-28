import { NextResponse } from "next/server"
import { exchangeCodeForTokens, resolveOrigin } from "@/lib/nest/client"

export const dynamic = "force-dynamic"

// Receives the Google auth code, exchanges it for tokens, stores them, then
// bounces the user back to the dashboard with a status flag.
export async function GET(req: Request) {
  const url = new URL(req.url)
  const code = url.searchParams.get("code")
  const oauthError = url.searchParams.get("error")
  const origin = resolveOrigin(req.url)

  if (oauthError) {
    return NextResponse.redirect(`${origin}/?nest=denied`)
  }
  if (!code) {
    return NextResponse.redirect(`${origin}/?nest=error`)
  }

  try {
    await exchangeCodeForTokens(code, origin)
    return NextResponse.redirect(`${origin}/?nest=connected`)
  } catch (err) {
    console.log("[v0] Nest callback token exchange failed:", err instanceof Error ? err.message : err)
    return NextResponse.redirect(`${origin}/?nest=error`)
  }
}
