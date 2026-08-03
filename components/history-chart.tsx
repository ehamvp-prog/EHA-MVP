"use client"

// ---------------------------------------------------------------------------
// Shared charting primitives so every history chart (Spending, Comfort,
// Efficiency, Savings) gets the SAME UX: a Daily/Weekly/Monthly toggle, a
// month/day/year historical picker with a reset-to-now button, and drill-down
// (tap a day on the weekly view → that day's detail; tap a week on monthly →
// that week). The chart bodies differ (bars vs. range-band lines) but the
// chrome and the range state are identical, which is the whole point.
// ---------------------------------------------------------------------------

import { useState, type ReactNode } from "react"
import { RefreshCw, ChevronDown } from "lucide-react"
import { chicagoParts, type ChartView } from "@/lib/chicago-time"

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

const pad2 = (n: number) => String(n).padStart(2, "0")

export type AvailableMonth = { year: number; month: number }

// Round up to a clean axis maximum (1/2/5 × 10ⁿ).
export function niceMax(v: number): number {
  if (v <= 0) return 0.1
  const pow = Math.pow(10, Math.floor(Math.log10(v)))
  const n = v / pow
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return step * pow
}

export function hourLabel(h: number): string {
  if (h === 0) return "12a"
  if (h === 12) return "12p"
  return h < 12 ? `${h}a` : `${h - 12}p`
}

// Local YYYY-MM-DD (Central) → short weekday + day, e.g. "Sat 27".
export function dayShortLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getUTCDay()]
  return `${wd} ${d}`
}

// ---- Range state hook -----------------------------------------------------

export type ChartRange = {
  view: ChartView
  setView: (v: ChartView) => void
  selYear: number
  selMonth: number
  selDay: number
  safeDay: number
  daysInMonth: number
  anchorIso: string
  todayY: number
  todayM: number
  todayD: number
  isCurrent: boolean
  setMonth: (m: number) => void
  setDay: (d: number) => void
  setYear: (y: number, availableMonths: AvailableMonth[]) => void
  resetToNow: () => void
  // Drill one level finer, anchored on the tapped date: monthly→weekly→daily.
  drillDown: (dateIso: string) => void
}

export function useChartRange(): ChartRange {
  const { year: todayY, month: todayM, day: todayD } = chicagoParts()
  const [view, setView] = useState<ChartView>("daily")
  const [selYear, setSelYear] = useState(todayY)
  const [selMonth, setSelMonth] = useState(todayM)
  const [selDay, setSelDay] = useState(todayD)

  const daysInMonth = new Date(Date.UTC(selYear, selMonth, 0)).getUTCDate()
  const safeDay = Math.min(selDay, daysInMonth)
  const anchorIso = `${selYear}-${pad2(selMonth)}-${pad2(safeDay)}`
  const isCurrent = selYear === todayY && selMonth === todayM && safeDay === todayD

  function resetToNow() {
    setSelYear(todayY)
    setSelMonth(todayM)
    setSelDay(todayD)
  }

  function drillDown(dateIso: string) {
    const [y, m, d] = dateIso.split("-").map(Number)
    if (!y || !m || !d) return
    setSelYear(y)
    setSelMonth(m)
    setSelDay(d)
    setView((v) => (v === "monthly" ? "weekly" : "daily"))
  }

  return {
    view,
    setView,
    selYear,
    selMonth,
    selDay,
    safeDay,
    daysInMonth,
    anchorIso,
    todayY,
    todayM,
    todayD,
    isCurrent,
    setMonth: (m) => {
      setSelMonth(m)
      setSelDay(1)
    },
    setDay: setSelDay,
    setYear: (y, availableMonths) => {
      setSelYear(y)
      const valid = availableMonths.filter((a) => a.year === y).map((a) => a.month)
      if (valid.length && !valid.includes(selMonth)) setSelMonth(Math.max(...valid))
      setSelDay(1)
    },
    resetToNow,
    drillDown,
  }
}

// ---- Controls (toggle + calendar + reset) ---------------------------------

export function ChartControls({
  range,
  availableMonths,
  toggleLabel = "Range",
}: {
  range: ChartRange
  availableMonths: AvailableMonth[]
  toggleLabel?: string
}) {
  const months = availableMonths.length ? availableMonths : [{ year: range.selYear, month: range.selMonth }]
  const years = Array.from(new Set(months.map((a) => a.year))).sort((a, b) => b - a)
  const monthsForYear = months.filter((a) => a.year === range.selYear).map((a) => a.month)

  return (
    <>
      <div
        className="mb-3 flex items-center gap-1 rounded-lg border border-border bg-card p-0.5"
        role="tablist"
        aria-label={toggleLabel}
      >
        {(["daily", "weekly", "monthly"] as ChartView[]).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={range.view === m}
            onClick={() => range.setView(m)}
            className={`flex-1 rounded-md px-2 py-1 text-xs font-medium capitalize transition-colors ${
              range.view === m ? "bg-accent text-accent-foreground" : "text-muted hover:text-foreground"
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      <div className="mb-3 flex items-center gap-2">
        <select
          aria-label="Select month"
          value={range.selMonth}
          onChange={(e) => range.setMonth(Number(e.target.value))}
          className="min-w-0 flex-1 rounded-lg border border-border bg-card px-2 py-1.5 text-xs font-medium text-foreground outline-none focus:border-accent"
        >
          {monthsForYear.map((m) => (
            <option key={m} value={m}>
              {MONTH_NAMES[m - 1]}
            </option>
          ))}
        </select>
        <select
          aria-label="Select day"
          value={range.safeDay}
          onChange={(e) => range.setDay(Number(e.target.value))}
          className="w-16 rounded-lg border border-border bg-card px-2 py-1.5 text-xs font-medium text-foreground outline-none focus:border-accent"
        >
          {Array.from({ length: range.daysInMonth }, (_, i) => i + 1).map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <select
          aria-label="Select year"
          value={range.selYear}
          onChange={(e) => range.setYear(Number(e.target.value), months)}
          className="w-20 rounded-lg border border-border bg-card px-2 py-1.5 text-xs font-medium text-foreground outline-none focus:border-accent"
        >
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={range.resetToNow}
          disabled={range.isCurrent}
          aria-label="Refresh to current readings"
          title="Back to current readings"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>
    </>
  )
}

// ---- Collapsible card wrapper ---------------------------------------------

export function ChartCard({
  icon,
  title,
  subtitle,
  badge,
  defaultOpen = false,
  children,
}: {
  icon: ReactNode
  title: string
  subtitle?: string
  badge?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-lg shadow-black/40">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border bg-elevated">
            {icon}
          </span>
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-foreground">{title}</h3>
            {subtitle ? <p className="truncate text-xs text-muted">{subtitle}</p> : null}
          </div>
          <ChevronDown className={`h-4 w-4 shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        {badge ? <div className="shrink-0">{badge}</div> : null}
      </div>
      {open ? <div className="mt-3">{children}</div> : null}
    </div>
  )
}

// ---- Range-band + line chart (comfort, efficiency) ------------------------

export type BandPoint = {
  day: string
  seg: number
  avg: number | null
  min: number | null
  max: number | null
}

export type RefLine = { value: number; label: string; color: string; dashed?: boolean }

// A series plotted on the SECONDARY (right) axis — e.g. 0–100 comfort scores
// drawn alongside a °F temperature band. `values` align to `points` by index.
export type RightSeries = {
  values: (number | null)[]
  color: string
  label: string
  step?: boolean // step interpolation (Happy Number holds flat between captures)
  dashed?: boolean
}

// Draws a shaded min→max band with the avg line on top. Optional flat/reference
// lines (e.g. rated SEER2) and optional right-axis series (e.g. comfort scores)
// so temperature (left, °F) and scores (right, 0–100) can share one chart
// honestly. In weekly/monthly views each day is a full-height tappable region
// that drills down. Pure SVG, token-driven colors.
export function BandLineChart({
  points,
  view,
  unit,
  digits = 0,
  bandColor,
  lineColor,
  refLines = [],
  rightSeries = [],
  rightDomain = [0, 100],
  rightUnit = "",
  onDrillDay,
  ariaLabel,
}: {
  points: BandPoint[]
  view: ChartView
  unit: string
  digits?: number
  bandColor: string
  lineColor: string
  refLines?: RefLine[]
  rightSeries?: RightSeries[]
  rightDomain?: [number, number]
  rightUnit?: string
  onDrillDay?: (day: string) => void
  ariaLabel: string
}) {
  const usable = points.filter((p) => p.avg != null)
  if (usable.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-card px-4 py-8 text-center text-sm text-muted">
        No readings recorded for this period yet.
      </p>
    )
  }

  const hasRight = rightSeries.length > 0
  const W = 340
  const H = 200
  const ml = 34
  const mr = hasRight ? 30 : 8 // room for the right (score) axis labels
  const mt = 12
  const mb = 24
  const plotX0 = ml
  const plotX1 = W - mr
  const plotW = plotX1 - plotX0
  const plotY0 = mt
  const plotY1 = H - mb
  const plotH = plotY1 - plotY0

  // Right (secondary) axis mapping — scores live here, NOT in the left domain.
  const [rd0, rd1] = rightDomain
  const rSpan = rd1 - rd0 || 1
  const yR = (v: number) => plotY1 - ((v - rd0) / rSpan) * plotH

  const allVals: number[] = []
  for (const p of points) {
    if (p.min != null) allVals.push(p.min)
    if (p.max != null) allVals.push(p.max)
    if (p.avg != null) allVals.push(p.avg)
  }
  for (const r of refLines) allVals.push(r.value)
  let lo = Math.min(...allVals)
  let hi = Math.max(...allVals)
  if (lo === hi) {
    lo -= 1
    hi += 1
  }
  const pad = (hi - lo) * 0.12
  lo -= pad
  hi += pad
  const span = hi - lo || 1

  const n = points.length
  const x = (i: number) => (n === 1 ? plotX0 + plotW / 2 : plotX0 + (i / (n - 1)) * plotW)
  const y = (v: number) => plotY1 - ((v - lo) / span) * plotH

  // Band polygon: forward along max, back along min (only where both exist).
  const bandTop = points.map((p, i) => (p.max != null ? `${x(i)},${y(p.max)}` : null)).filter(Boolean)
  const bandBot = points
    .map((p, i) => (p.min != null ? `${x(i)},${y(p.min)}` : null))
    .filter(Boolean)
    .reverse()
  const bandPath = bandTop.length && bandBot.length ? `M ${bandTop.join(" L ")} L ${bandBot.join(" L ")} Z` : ""

  // Avg line (break on gaps).
  const segs: string[] = []
  let cur: string[] = []
  points.forEach((p, i) => {
    if (p.avg == null) {
      if (cur.length) segs.push(`M ${cur.join(" L ")}`)
      cur = []
    } else {
      cur.push(`${x(i)},${y(p.avg)}`)
    }
  })
  if (cur.length) segs.push(`M ${cur.join(" L ")}`)
  const avgPath = segs.join(" ")

  // Day groupings for x labels + drill regions.
  const dayGroups: { day: string; startI: number; endI: number }[] = []
  points.forEach((p, i) => {
    const last = dayGroups[dayGroups.length - 1]
    if (last && last.day === p.day) last.endI = i
    else dayGroups.push({ day: p.day, startI: i, endI: i })
  })
  const canDrill = view !== "daily" && !!onDrillDay

  // Full-width horizontal bounds of a day group's column (used by both the
  // x-axis label position and the full-height tap target).
  const dayBounds = (g: { startI: number; endI: number }): [number, number] => {
    const gx0 = x(g.startI) - (g.startI === 0 ? 0 : (x(g.startI) - x(g.startI - 1)) / 2)
    const gx1 = x(g.endI) + (g.endI === n - 1 ? 0 : (x(g.endI + 1) - x(g.endI)) / 2)
    return [gx0, gx1]
  }

  const ticks = [lo + span * 0.05, (lo + hi) / 2, hi - span * 0.05]

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: "auto" }} role="img" aria-label={ariaLabel}>
      {/* y grid + labels */}
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={plotX0} y1={y(t)} x2={plotX1} y2={y(t)} stroke="var(--color-border)" strokeWidth={0.5} />
          <text x={plotX0 - 4} y={y(t) + 3} textAnchor="end" fontSize={9} fill="var(--color-muted)">
            {Math.round(t)}
          </text>
        </g>
      ))}

      {/* day x-axis labels (drill hit-targets are rendered last, on top) */}
      {view !== "daily" &&
        dayGroups.map((g) => {
          const [gx0, gx1] = dayBounds(g)
          return (
            <text
              key={g.day}
              x={(gx0 + gx1) / 2}
              y={H - 8}
              textAnchor="middle"
              fontSize={9}
              fill="var(--color-muted)"
            >
              {g.day.slice(8, 10)}
            </text>
          )
        })}

      {/* daily x labels (every 4h) */}
      {view === "daily" &&
        points.map((p, i) =>
          i % 4 === 0 ? (
            <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize={9} fill="var(--color-muted)">
              {hourLabel(Math.round((p.seg / (n || 1)) * 24))}
            </text>
          ) : null,
        )}

      {/* band */}
      {bandPath ? <path d={bandPath} fill={bandColor} fillOpacity={0.18} /> : null}

      {/* reference / flat lines */}
      {refLines.map((r, i) => (
        <g key={i}>
          <line
            x1={plotX0}
            y1={y(r.value)}
            x2={plotX1}
            y2={y(r.value)}
            stroke={r.color}
            strokeWidth={1.5}
            strokeDasharray={r.dashed === false ? undefined : "4 3"}
          />
          <text x={plotX1} y={y(r.value) - 3} textAnchor="end" fontSize={9} fontWeight={600} fill={r.color}>
            {r.label}
          </text>
        </g>
      ))}

      {/* avg line */}
      <path d={avgPath} fill="none" stroke={lineColor} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

      {/* endpoint value (left axis) */}
      {(() => {
        const lastIdx = [...points].map((p, i) => (p.avg != null ? i : -1)).filter((i) => i >= 0).pop()
        if (lastIdx == null) return null
        const v = points[lastIdx].avg as number
        return (
          <text
            x={Math.min(x(lastIdx), plotX1 - 2)}
            y={Math.max(y(v) - 6, 10)}
            textAnchor="end"
            fontSize={11}
            fontWeight={600}
            fill="var(--color-foreground)"
          >
            {v.toFixed(digits)}
            {unit}
          </text>
        )
      })()}

      {/* right (score) axis ticks + series */}
      {hasRight ? (
        <>
          {[rd0, (rd0 + rd1) / 2, rd1].map((t, i) => (
            <text key={`r${i}`} x={plotX1 + 4} y={yR(t) + 3} textAnchor="start" fontSize={9} fill="var(--color-muted)">
              {Math.round(t)}
              {rightUnit}
            </text>
          ))}
          {rightSeries.map((s, si) => {
            // Break the path on nulls; step = hold flat then jump (learning steps).
            const segsR: string[] = []
            let cur: string[] = []
            let prev: number | null = null
            s.values.forEach((v, i) => {
              if (v == null) {
                if (cur.length) segsR.push(`M ${cur.join(" L ")}`)
                cur = []
                prev = null
                return
              }
              if (s.step && prev != null) cur.push(`${x(i)},${yR(prev)}`) // horizontal hold
              cur.push(`${x(i)},${yR(v)}`)
              prev = v
            })
            if (cur.length) segsR.push(`M ${cur.join(" L ")}`)
            return (
              <path
                key={`rs${si}`}
                d={segsR.join(" ")}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray={s.dashed ? "5 3" : undefined}
              />
            )
          })}
        </>
      ) : null}

      {/* FULL-HEIGHT drill hit-targets — rendered LAST so a tap anywhere in a
          day's column (even directly on the band or a line) drills in. */}
      {canDrill &&
        dayGroups.map((g) => {
          const [gx0, gx1] = dayBounds(g)
          return (
            <rect
              key={`hit-${g.day}`}
              x={gx0}
              y={plotY0}
              width={Math.max(gx1 - gx0, 1)}
              height={plotH}
              fill="transparent"
              className="cursor-pointer"
              onClick={() => onDrillDay!(g.day)}
            >
              <title>{`Open ${g.day}`}</title>
            </rect>
          )
        })}
    </svg>
  )
}

// ---- Diverging bars (savings: gross up, costs down) -----------------------

export type SavingsBar = {
  key: string
  date: string
  label: string
  net: number
  gross: number
  costs: number // already negative
}

export function DivergingBars({
  bars,
  view,
  onDrill,
}: {
  bars: SavingsBar[]
  view: ChartView
  onDrill?: (dateIso: string) => void
}) {
  if (bars.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-card px-4 py-8 text-center text-sm text-muted">
        No measured savings for this period yet.
      </p>
    )
  }

  const W = 340
  const H = 200
  const ml = 34
  const mr = 8
  const mt = 14
  const mb = 26
  const plotX0 = ml
  const plotX1 = W - mr
  const plotW = plotX1 - plotX0
  const plotY0 = mt
  const plotY1 = H - mb
  const plotH = plotY1 - plotY0

  const maxUp = Math.max(...bars.map((b) => b.gross), 0)
  const maxDown = Math.min(...bars.map((b) => b.costs), 0)
  const upMax = niceMax(maxUp || 0.1)
  const downMax = niceMax(Math.abs(maxDown) || 0.01)
  const totalSpan = upMax + downMax || 1
  const zeroY = plotY0 + (upMax / totalSpan) * plotH
  const yUp = (v: number) => zeroY - (v / upMax) * (zeroY - plotY0)
  const yDown = (v: number) => zeroY + (Math.abs(v) / downMax) * (plotY1 - zeroY)

  const n = bars.length
  const slot = plotW / n
  const barW = Math.max(slot * 0.5, 3)
  const canDrill = view !== "daily" && !!onDrill

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: "auto" }} role="img" aria-label="Measured savings bars">
      {/* zero baseline */}
      <line x1={plotX0} y1={zeroY} x2={plotX1} y2={zeroY} stroke="var(--color-border)" strokeWidth={1} />
      <text x={plotX0 - 4} y={plotY0 + 6} textAnchor="end" fontSize={9} fill="var(--color-muted)">
        ${upMax.toFixed(2)}
      </text>

      {bars.map((b, i) => {
        const cx = plotX0 + i * slot + slot / 2
        const gTop = yUp(b.gross)
        const cBot = yDown(b.costs)
        return (
          <g key={b.key}>
            {/* gross (up, green) */}
            {b.gross > 0 ? (
              <rect x={cx - barW / 2} y={gTop} width={barW} height={Math.max(zeroY - gTop, 0)} rx={1.5} fill="var(--color-ok)" />
            ) : null}
            {/* cost (down, red) */}
            {b.costs < 0 ? (
              <rect x={cx - barW / 2} y={zeroY} width={barW} height={Math.max(cBot - zeroY, 0)} rx={1.5} fill="var(--color-warn)" />
            ) : null}
            {/* x label */}
            <text x={cx} y={H - 8} textAnchor="middle" fontSize={8} fill="var(--color-muted)">
              {b.label.replace(/^[A-Za-z]+ /, "")}
            </text>
          </g>
        )
      })}

      {/* FULL-HEIGHT drill hit-targets on top: tap anywhere in a column, not
          just on the bar, to open that period. */}
      {canDrill &&
        bars.map((b, i) => (
          <rect
            key={`hit-${b.key}`}
            x={plotX0 + i * slot}
            y={plotY0}
            width={slot}
            height={plotH}
            fill="transparent"
            className="cursor-pointer"
            onClick={() => onDrill!(b.date)}
          >
            <title>{`Open ${b.label}`}</title>
          </rect>
        ))}
    </svg>
  )
}
