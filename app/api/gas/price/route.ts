// =====================================================================
// /api/gas/price
//   GET   what the app is pricing gas at right now, and where it came from
//   POST  refresh the Kansas Gas Service monthly cost of gas (cron, daily)
//         Auth: "Authorization: Bearer <AUTOMATION_TICK_SECRET>"
// =====================================================================

import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { SITE_ID } from "@/lib/compute-reading"
import { fetchKgsCostOfGas, KGS_COST_OF_GAS_URL } from "@/lib/gas/kgs"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const COLS =
  "gas_type, gas_cost_of_gas_per_mcf, gas_cog_period, gas_cog_checked_at, gas_delivery_per_mcf, gas_rate_override_per_mcf, gas_rate_per_therm, gas_heating_value_btu_per_cuft"

function shape(p: Record<string, unknown> | null) {
  const n = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v))
  const cog = n(p?.gas_cost_of_gas_per_mcf)
  const delivery = n(p?.gas_delivery_per_mcf)
  const override = n(p?.gas_rate_override_per_mcf)
  const perMcf = override ?? (cog != null ? cog + (delivery ?? 0) : null)
  return {
    source: override != null ? "manual" : cog != null ? "kansas_gas_service" : "none",
    per_mcf: perMcf != null ? Math.round(perMcf * 10000) / 10000 : null,
    per_therm: n(p?.gas_rate_per_therm),
    cost_of_gas_per_mcf: cog,
    delivery_per_mcf: delivery,
    period: (p?.gas_cog_period as string | null) ?? null,
    checked_at: (p?.gas_cog_checked_at as string | null) ?? null,
    gas_type: (p?.gas_type as string | null) ?? null,
    source_url: KGS_COST_OF_GAS_URL,
  }
}

export async function GET() {
  const supabase = createAdminClient()
  const { data, error } = await supabase.from("system_profile").select(COLS).eq("site_id", SITE_ID).maybeSingle()
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, ...shape(data as Record<string, unknown> | null) })
}

export async function POST(request: Request) {
  const secret = process.env.AUTOMATION_TICK_SECRET
  const provided = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim()
  if (!secret || provided !== secret) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 })
  }
  const supabase = createAdminClient()
  try {
    const cog = await fetchKgsCostOfGas()
    const { data, error } = await supabase
      .from("system_profile")
      .update({
        gas_cost_of_gas_per_mcf: cog.perMcf,
        gas_cog_period: cog.period,
        gas_cog_checked_at: new Date().toISOString(),
      })
      .eq("site_id", SITE_ID)
      .select(COLS)
      .maybeSingle()
    if (error) throw new Error(error.message)
    return NextResponse.json({ ok: true, refreshed: true, ...shape(data as Record<string, unknown> | null) })
  } catch (e) {
    // Keep pricing with the last good number; just report the miss.
    const message = e instanceof Error ? e.message : "refresh failed"
    console.log("[gas] cost-of-gas refresh failed:", message)
    return NextResponse.json({ ok: false, error: message }, { status: 502 })
  }
}
