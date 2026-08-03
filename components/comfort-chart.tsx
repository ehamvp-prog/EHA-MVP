"use client"

import useSWR from "swr"
import { Gauge } from "lucide-react"
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
  avgTemp: number | null
  minTemp: number | null
  maxTemp: number | null
  avgRh: number | null
  source: string | null
}
type Resp = {
  ok: boolean
  view: "daily" | "weekly" | "monthly"
  happy: number
  preferredTemp: number
  points: SegPoint[]
  availableMonths: AvailableMonth[]
}

// Standalone INDOOR TEMPERATURE history. The min→max band is the whole point:
// a 4–6pm 76°F spike is visible as the top of the band instead of being
// averaged into a flat ~71°. Target temperature is a dashed reference line;
// the Happy Number (constant comfort of the user's target) rides as a chip.
// Daily/Weekly/Monthly + historical search + drill-down come from the shell.
export function ComfortChart() {
  const range = useChartRange()
  const { data } = useSWR<Resp>(
    `/api/comfort/segments?date=${range.anchorIso}&view=${range.view}`,
    fetcher,
    { refreshInterval: 60000 },
  )

  const months = data?.availableMonths ?? [{ year: range.selYear, month: range.selMonth }]
  const points: BandPoint[] = (data?.points ?? []).map((p) => ({
    day: p.day,
    seg: p.seg,
    avg: p.avgTemp,
    min: p.minTemp,
    max: p.maxTemp,
  }))

  const title =
    range.view === "daily"
      ? `${MONTH_NAMES[range.selMonth - 1]} ${range.safeDay}, ${range.selYear} — indoor temperature`
      : range.view === "weekly"
        ? `${MONTH_NAMES[range.selMonth - 1]} ${range.selYear} — this week, by time of day`
        : `${MONTH_NAMES[range.selMonth - 1]} ${range.selYear} — full month`

  const source = data?.points.find((p) => p.source)?.source

  return (
    <ChartCard
      icon={<Gauge className="h-5 w-5 text-accent" />}
      title="Comfort history"
      subtitle="Indoor temperature range over time"
      badge={
        data ? (
          <div className="rounded-xl border border-accent/30 bg-accent/10 px-3 py-1.5 text-right">
            <p className="text-[10px] uppercase tracking-wide text-muted">Happy Number</p>
            <p className="text-sm font-bold tabular-nums text-accent">{Math.round(data.happy)}</p>
          </div>
        ) : null
      }
    >
      <div className="rounded-xl border border-accent/40 bg-elevated p-4">
        <ChartControls range={range} availableMonths={months} toggleLabel="Comfort range" />
        <h4 className="mb-2 text-center text-sm font-semibold text-foreground text-pretty">{title}</h4>

        {!data ? (
          <p className="rounded-lg border border-border bg-card px-4 py-8 text-center text-sm text-muted">Loading…</p>
        ) : (
          <>
            <BandLineChart
              points={points}
              view={range.view}
              unit="°"
              digits={0}
              bandColor="var(--color-accent)"
              lineColor="var(--color-accent)"
              refLines={[
                { value: data.preferredTemp, label: `Target ${Math.round(data.preferredTemp)}°`, color: "var(--color-ok)" },
              ]}
              onDrillDay={range.drillDown}
              ariaLabel="Indoor temperature range over time"
            />
            <p className="mt-2 text-center text-xs text-muted">
              Shaded band spans the coolest-to-warmest reading in each slot.
              {range.view !== "daily" ? " Tap a day to zoom in." : ""}
              {source ? ` · source: ${source === "nest" ? "Nest" : "return sensor"}` : ""}
            </p>
          </>
        )}
      </div>
    </ChartCard>
  )
}
