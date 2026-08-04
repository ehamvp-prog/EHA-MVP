"use client"

import useSWR from "swr"
import { PiggyBank } from "lucide-react"
import { AutomationJournalCard } from "@/components/automation-journal"
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

type Bucket = {
  type: "free_cooling" | "comfort_adjust" | "peak_coast" | "peak_precool"
  label: string
  description: string
  kind: "saving" | "cost"
  amount: number
  events: number
}

type Resp = {
  ok: boolean
  view: "daily" | "weekly" | "monthly"
  grain: string
  bars: SavingsBar[]
  buckets: Bucket[]
  totals: { gross: number; costs: number; net: number; kwhShifted: number }
  availableMonths: AvailableMonth[]
}

const money = (v: number) => `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}`

// Distinct color per mechanism, from the theme's state tokens. Free cooling is
// the largest positive source, so it takes the primary "ok" green.
const BUCKET_COLOR: Record<Bucket["type"], string> = {
  free_cooling: "var(--color-ok)",
  comfort_adjust: "var(--color-primary)",
  peak_coast: "var(--color-accent)",
  peak_precool: "var(--color-bad)",
}

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
  const totals = data?.totals ?? { gross: 0, costs: 0, net: 0, kwhShifted: 0 }

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

            {totals.kwhShifted > 0 ? (
              <p className="mt-3 text-center text-xs text-muted">
                {totals.kwhShifted.toFixed(1)} kWh shifted out of peak hours
                {range.view !== "daily" ? " · tap a bar to zoom in" : ""}
              </p>
            ) : range.view !== "daily" ? (
              <p className="mt-3 text-center text-xs text-muted">Tap a bar to zoom in</p>
            ) : null}

            {/* Where the net came from — the four mechanisms shown separately,
                since they tell different stories and free cooling is now the
                largest single source. */}
            <BucketBreakdown buckets={data.buckets ?? []} net={totals.net} />

            {/* Automation journal — slim, borderless toggle at the very bottom;
                the per-event story behind the savings above. */}
            <AutomationJournalCard embedded />
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

// Composition of the net: a diverging stacked bar (positive mechanisms extend
// right from the zero line, pre-cooling cost extends left) plus a labeled list
// with each mechanism's one-liner, dollar amount, and event count. Zero-event
// buckets stay listed but dimmed, so a period with no free cooling reads as an
// explicit "no events" line rather than a silent omission.
function BucketBreakdown({ buckets, net }: { buckets: Bucket[]; net: number }) {
  if (buckets.length === 0) return null

  const positives = buckets.filter((b) => b.amount > 0)
  const posTotal = positives.reduce((s, b) => s + b.amount, 0)
  const costTotal = buckets.filter((b) => b.amount < 0).reduce((s, b) => s + Math.abs(b.amount), 0)
  const span = posTotal + costTotal
  const hasAny = buckets.some((b) => b.events > 0)

  // Zero line sits where the red cost segment ends and greens begin.
  const zeroPct = span > 0 ? (costTotal / span) * 100 : 0

  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h5 className="text-xs font-semibold uppercase tracking-wide text-muted">Where it came from</h5>
        <span className={`text-xs font-bold tabular-nums ${net < 0 ? "text-warn" : "text-ok"}`}>
          {money(net)} net
        </span>
      </div>

      {/* Diverging composition bar */}
      {span > 0 ? (
        <div className="relative mb-3 h-3 w-full overflow-hidden rounded-full bg-card" role="img" aria-label="Savings composition by mechanism">
          <div className="flex h-full w-full">
            {/* Cost extends left toward the zero line */}
            {costTotal > 0 ? (
              <div
                className="h-full"
                style={{ width: `${(costTotal / span) * 100}%`, backgroundColor: BUCKET_COLOR.peak_precool }}
              />
            ) : null}
            {/* Positive mechanisms stack rightward */}
            {positives.map((b) => (
              <div
                key={b.type}
                className="h-full"
                style={{ width: `${(b.amount / span) * 100}%`, backgroundColor: BUCKET_COLOR[b.type] }}
              />
            ))}
          </div>
          {/* Zero baseline marker */}
          {costTotal > 0 ? (
            <div className="absolute inset-y-0 w-px bg-foreground/60" style={{ left: `${zeroPct}%` }} aria-hidden />
          ) : null}
        </div>
      ) : (
        <div className="mb-3 h-3 w-full rounded-full bg-card" aria-hidden />
      )}

      {!hasAny ? (
        <p className="rounded-lg border border-border bg-card px-3 py-3 text-center text-xs text-muted">
          No measured savings events in this period.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {buckets.map((b) => {
            const dim = b.events === 0
            const isCost = b.kind === "cost"
            return (
              <li key={b.type} className={`flex items-start gap-2.5 ${dim ? "opacity-45" : ""}`}>
                <span
                  className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: BUCKET_COLOR[b.type] }}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-semibold text-foreground">{b.label}</span>
                    <span
                      className={`shrink-0 text-xs font-bold tabular-nums ${isCost ? "text-warn" : "text-ok"}`}
                    >
                      {money(b.amount)}
                    </span>
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted text-pretty">{b.description}</p>
                  <p className="text-[10px] text-muted">
                    {dim ? "no events this period" : `${b.events} event${b.events === 1 ? "" : "s"}`}
                  </p>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
