"use client"

import useSWR from "swr"
import { PiggyBank } from "lucide-react"
import {
  useChartRange,
  ChartControls,
  ChartCard,
  DivergingBars,
  MONTH_NAMES,
  type AvailableMonth,
  type SavingsBar,
} from "@/components/history-chart"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

type Resp = {
  ok: boolean
  view: "daily" | "weekly" | "monthly"
  grain: string
  bars: SavingsBar[]
  totals: { gross: number; costs: number; net: number; shifted: number }
  availableMonths: AvailableMonth[]
}

const money = (v: number) => `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}`

// Savings answers "what did Elevate do for me" — deliberately SEPARATE from the
// cost chart ("what am I spending"). Diverging bars: green above the axis is
// what the automations earned (gross), red below is what pre-cooling spent at
// off-peak to dodge on-peak. Both halves are shown on purpose — the net is only
// honest with the cost visible. Bars, not a line. Historical search + drill-down
// come from the shared shell.
export function SavingsSection() {
  const range = useChartRange()
  const { data } = useSWR<Resp>(
    `/api/savings/range?date=${range.anchorIso}&view=${range.view}`,
    fetcher,
    { refreshInterval: 60000 },
  )

  const months = data?.availableMonths ?? [{ year: range.selYear, month: range.selMonth }]
  const totals = data?.totals ?? { gross: 0, costs: 0, net: 0, shifted: 0 }

  const title =
    range.view === "daily"
      ? `${MONTH_NAMES[range.selMonth - 1]} ${range.safeDay}, ${range.selYear}`
      : range.view === "weekly"
        ? `${MONTH_NAMES[range.selMonth - 1]} ${range.selYear} — this week`
        : `${MONTH_NAMES[range.selMonth - 1]} ${range.selYear} — full month`

  return (
    <ChartCard
      icon={<PiggyBank className="h-5 w-5 text-ok" />}
      title="Your savings"
      subtitle="Measured from real power"
      badge={
        data ? (
          <div
            className={`rounded-xl border px-3 py-1.5 text-right ${
              totals.net < 0 ? "border-warn/30 bg-warn/10" : "border-ok/30 bg-ok/10"
            }`}
          >
            <p className="text-[10px] uppercase tracking-wide text-muted">Net</p>
            <p className={`text-sm font-bold tabular-nums ${totals.net < 0 ? "text-warn" : "text-ok"}`}>
              {money(totals.net)}
            </p>
          </div>
        ) : null
      }
    >
      <div className="rounded-xl border border-ok/40 bg-elevated p-4">
        <ChartControls range={range} availableMonths={months} toggleLabel="Savings" />
        <h4 className="mb-2 text-center text-sm font-semibold text-foreground text-pretty">{title}</h4>

        {!data ? (
          <p className="rounded-lg border border-border bg-card px-4 py-8 text-center text-sm text-muted">Loading…</p>
        ) : (
          <>
            <DivergingBars bars={data.bars} view={range.view} onDrill={range.drillDown} />

            {/* Gross / Costs / Net — the honest bottom line, all three shown. */}
            <div className="mt-4 grid grid-cols-3 gap-2">
              <Figure label="Gross" value={money(totals.gross)} tone="ok" hint="earned" />
              <Figure label="Costs" value={money(totals.costs)} tone="warn" hint="pre-cooling" />
              <Figure label="Net" value={money(totals.net)} tone={totals.net < 0 ? "warn" : "ok"} hint="bottom line" />
            </div>

            {totals.shifted > 0 ? (
              <p className="mt-3 text-center text-xs text-muted">
                {totals.shifted.toFixed(1)} kWh shifted out of peak hours
                {range.view !== "daily" ? " · tap a bar to zoom in" : ""}
              </p>
            ) : range.view !== "daily" ? (
              <p className="mt-3 text-center text-xs text-muted">Tap a bar to zoom in</p>
            ) : null}
          </>
        )}
      </div>
    </ChartCard>
  )
}

function Figure({
  label,
  value,
  tone,
  hint,
}: {
  label: string
  value: string
  tone: "ok" | "warn"
  hint: string
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-2.5 text-center">
      <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
      <p className={`text-sm font-bold tabular-nums ${tone === "warn" ? "text-warn" : "text-ok"}`}>{value}</p>
      <p className="mt-0.5 text-[10px] text-muted">{hint}</p>
    </div>
  )
}
