"use client"

import useSWR from "swr"
import { Zap } from "lucide-react"
import {
  useChartRange,
  ChartControls,
  ChartCard,
  BandLineChart,
  MONTH_NAMES,
  type AvailableMonth,
  type BandPoint,
} from "@/components/history-chart"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

type SegPoint = {
  day: string
  seg: number
  avgEer: number | null
  minEer: number | null
  maxEer: number | null
  capacity: number | null
}
type Resp = {
  ok: boolean
  view: "daily" | "weekly" | "monthly"
  ratedSeer2: number
  points: SegPoint[]
  availableMonths: AvailableMonth[]
}

// NEW efficiency history — measured, not asserted. Plots live EER (min→max band
// around the average) against the unit's rated SEER2 reference line, so you can
// see efficiency sag through the heat of the day and still beat nameplate.
// Replaces the static "Running great" text card. Same shell chrome as the
// other charts: Daily/Weekly/Monthly, historical search, day drill-down.
export function EfficiencyChart() {
  const range = useChartRange()
  const { data } = useSWR<Resp>(
    `/api/efficiency/segments?date=${range.anchorIso}&view=${range.view}`,
    fetcher,
    { refreshInterval: 60000 },
  )

  const months = data?.availableMonths ?? [{ year: range.selYear, month: range.selMonth }]
  const points: BandPoint[] = (data?.points ?? []).map((p) => ({
    day: p.day,
    seg: p.seg,
    avg: p.avgEer,
    min: p.minEer,
    max: p.maxEer,
  }))

  const eers = (data?.points ?? []).map((p) => p.avgEer).filter((v): v is number => v != null)
  const avgEer = eers.length ? eers.reduce((a, b) => a + b, 0) / eers.length : null

  const title =
    range.view === "daily"
      ? `${MONTH_NAMES[range.selMonth - 1]} ${range.safeDay}, ${range.selYear} — efficiency by hour`
      : range.view === "weekly"
        ? `${MONTH_NAMES[range.selMonth - 1]} ${range.selYear} — this week, by time of day`
        : `${MONTH_NAMES[range.selMonth - 1]} ${range.selYear} — full month`

  return (
    <ChartCard
      icon={<Zap className="h-5 w-5 text-warn" />}
      title="Efficiency history"
      subtitle="Measured performance, minute by minute"
      badge={
        avgEer != null ? (
          <div className="rounded-xl border border-warn/30 bg-warn/10 px-3 py-1.5 text-right">
            <p className="text-[10px] uppercase tracking-wide text-muted">Avg EER</p>
            <p className="text-sm font-bold tabular-nums text-warn">{avgEer.toFixed(1)}</p>
          </div>
        ) : null
      }
    >
      <div className="rounded-xl border border-warn/40 bg-elevated p-4">
        <ChartControls range={range} availableMonths={months} toggleLabel="Efficiency" />
        <h4 className="mb-2 text-center text-sm font-semibold text-foreground text-pretty">{title}</h4>

        {!data ? (
          <p className="rounded-lg border border-border bg-card px-4 py-8 text-center text-sm text-muted">Loading…</p>
        ) : points.every((p) => p.avg == null) ? (
          <p className="rounded-lg border border-border bg-card px-4 py-8 text-center text-sm text-muted">
            No steady-state runtime in this window to measure.
          </p>
        ) : (
          <>
            <BandLineChart
              points={points}
              view={range.view}
              unit=""
              digits={1}
              bandColor="var(--color-warn)"
              lineColor="var(--color-warn)"
              refLines={[
                {
                  value: data.ratedSeer2,
                  label: `Rated ${data.ratedSeer2}`,
                  color: "var(--color-muted)",
                },
              ]}
              onDrillDay={range.drillDown}
              ariaLabel="Measured EER over time against rated SEER2"
            />
            <p className="mt-2 text-center text-xs text-muted">
              Higher is better. Band spans the range within each slot; dashed line is the unit&apos;s rated efficiency.
              {range.view !== "daily" ? " Tap a day to zoom in." : ""}
            </p>
          </>
        )}
      </div>
    </ChartCard>
  )
}
