// =====================================================================
// GET /api/savings/range?date=YYYY-MM-DD&view=daily|weekly|monthly
// Read-only. MEASURED savings bars for the anchor window, via the savings_range
// RPC. Grain follows the view: weekly/daily → per-day bars, monthly → per-week
// bars. Each bar carries gross (earned by coasting) and costs (spent
// pre-cooling, already negative) so the honest net is visible — hiding the cost
// half would make the headline dishonest. Also returns the selectable month
// list. Changes no data.
// =====================================================================

import { NextResponse } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { SITE_ID } from "@/lib/compute-reading"
import { chicagoParts, chicagoChartWindow, type ChartView } from "@/lib/chicago-time"

export const dynamic = "force-dynamic"

type RangeRow = {
  bucket_start: string
  label: string | null
  net_savings_usd: number | string | null
  gross_savings_usd: number | string | null
  costs_usd: number | string | null
  kwh_shifted: number | string | null
  actions: number | string | null
  unmeasurable: number | string | null
}

function parseView(v: string | null): ChartView {
  return v === "weekly" || v === "monthly" ? v : "daily"
}

const money = (v: number | string | null): number =>
  v == null ? 0 : Math.round(Number(v) * 100) / 100

// Chicago calendar date (YYYY-MM-DD) for a bucket_start instant — the anchor a
// drill-down jumps to when a bar is tapped.
const CHI_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})
const chicagoDate = (ts: string): string => CHI_DAY.format(new Date(ts))

export async function GET(request: Request) {
  try {
    const supabase = createAdminClient()
    const { searchParams } = new URL(request.url)
    const view = parseView(searchParams.get("view"))

    const today = chicagoParts()
    const raw = searchParams.get("date")
    const p = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw.split("-").map(Number) : null
    const year = p ? p[0] : today.year
    const month = p ? p[1] : today.month
    const day = p ? p[2] : today.day

    const { fromISO, toISO } = chicagoChartWindow(view, year, month, day)
    const grain = view === "monthly" ? "week" : "day"

    const [rangeRes, monthsRes, bucketRes] = await Promise.all([
      supabase.rpc("savings_range", {
        p_site_id: SITE_ID,
        p_from: fromISO,
        p_to: toISO,
        p_grain: grain,
      }),
      supabase
        .from("energy_monthly")
        .select("month_local")
        .eq("site_id", SITE_ID)
        .order("month_local", { ascending: false }),
      // Per-action-type split over the same window. Aggregated in Postgres
      // (<=4 rows), so the four savings mechanisms can be shown as separate
      // contributors instead of one blended net.
      supabase.rpc("savings_by_action", {
        p_site_id: SITE_ID,
        p_from: fromISO,
        p_to: toISO,
      }),
    ])
    if (rangeRes.error) throw rangeRes.error
    if (bucketRes.error) throw bucketRes.error

    const bars = ((rangeRes.data ?? []) as RangeRow[]).map((r) => ({
      key: String(r.bucket_start),
      date: chicagoDate(String(r.bucket_start)),
      label: r.label ?? "",
      net: money(r.net_savings_usd),
      gross: money(r.gross_savings_usd),
      costs: money(r.costs_usd),
      kwhShifted: money(r.kwh_shifted),
      actions: Number(r.actions ?? 0),
      unmeasurable: Number(r.unmeasurable ?? 0),
    }))

    const net = Math.round(bars.reduce((s, b) => s + b.net, 0) * 100) / 100
    const gross = Math.round(bars.reduce((s, b) => s + b.gross, 0) * 100) / 100
    const costs = Math.round(bars.reduce((s, b) => s + b.costs, 0) * 100) / 100
    const kwhShifted = Math.round(bars.reduce((s, b) => s + b.kwhShifted, 0) * 10) / 10

    // Per-action-type contributors. The four mechanisms tell different stories,
    // so we always emit all four in a fixed order (zero-filled when a type has
    // no events in the window) rather than a single blended number.
    type BucketRow = { action_type: string; events: number | string; total_usd: number | string }
    const byType = new Map<string, { events: number; total: number }>()
    for (const r of (bucketRes.data ?? []) as BucketRow[]) {
      byType.set(r.action_type, { events: Number(r.events ?? 0), total: money(r.total_usd) })
    }
    const BUCKET_META: { type: string; label: string; description: string; kind: "saving" | "cost" }[] = [
      {
        type: "free_cooling",
        label: "Free cooling",
        description: "Cooling recovered from the coil after the compressor shuts off, at no extra energy cost.",
        kind: "saving",
      },
      {
        type: "comfort_adjust",
        label: "Comfort adjustments",
        description: "Setpoint changes that measurably reduced runtime.",
        kind: "saving",
      },
      {
        type: "peak_coast",
        label: "Peak coasting",
        description: "Load moved out of expensive hours.",
        kind: "saving",
      },
      {
        type: "peak_precool",
        label: "Pre-cooling",
        description: "Energy spent early at cheap rates to avoid expensive rates.",
        kind: "cost",
      },
    ]
    const buckets = BUCKET_META.map((m) => {
      const hit = byType.get(m.type)
      return {
        type: m.type,
        label: m.label,
        description: m.description,
        kind: m.kind,
        amount: hit?.total ?? 0,
        events: hit?.events ?? 0,
      }
    })

    const availableMonths = ((monthsRes.data ?? []) as { month_local: string }[]).map((r) => {
      const [y, m] = String(r.month_local).split("-").map(Number)
      return { year: y, month: m }
    })
    if (availableMonths.length === 0) availableMonths.push({ year, month })

    return NextResponse.json({
      ok: true,
      view,
      year,
      month,
      day,
      grain,
      bars,
      buckets,
      totals: { net, gross, costs, kwhShifted },
      availableMonths,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
