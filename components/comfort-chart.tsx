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
  comfortScore: number | null
  happyStep: number | null
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

// Standalone comfort history with two honest axes:
//   • LEFT (°F): indoor temperature min→max band + avg line. The band is the
//     point — a 4–6pm 76°F spike shows as the top of the band, not averaged away.
//   • RIGHT (0–100): the live Comfort Score per bucket AND the Happy Number as a
//     STEP line that jumps each time the system is trained. Comparing the two
//     scores is the story: "how comfortable were we vs. our moving target?"
// No target-temperature line. Daily/Weekly/Monthly + search + drill from the shell.
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
      subtitle="Temperature, comfort score & your Happy Number"
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
              rightDomain={[0, 100]}
              rightUnit=""
              rightSeries={[
                {
                  values: (data.points ?? []).map((p) => p.comfortScore),
                  color: "var(--color-ok)",
                  label: "Comfort Score",
                },
                {
                  values: (data.points ?? []).map((p) => p.happyStep),
                  color: "var(--color-warn)",
                  label: "Happy Number",
                  step: true,
                  dashed: true,
                },
              ]}
              onDrillDay={range.drillDown}
              ariaLabel="Indoor temperature and comfort scores over time"
            />
            {/* legend */}
            <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[10px] text-muted">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-3 rounded-sm bg-accent/40" aria-hidden /> Temp range (°F, left)
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-0.5 w-3 rounded-sm bg-ok" aria-hidden /> Comfort Score (right)
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-0.5 w-3 rounded-sm bg-warn" aria-hidden /> Happy Number (right)
              </span>
            </div>
            <p className="mt-1 text-center text-xs text-muted">
              Scores are 0–100; the Happy Number steps up when you train the system.
              {range.view !== "daily" ? " Tap any day to zoom in." : ""}
              {source ? ` · source: ${source === "nest" ? "Nest" : "return sensor"}` : ""}
            </p>
          </>
        )}
      </div>
    </ChartCard>
  )
}
