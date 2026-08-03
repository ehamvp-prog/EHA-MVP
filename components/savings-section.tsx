"use client"

import { useState } from "react"
import useSWR from "swr"
import { PiggyBank, ChevronDown } from "lucide-react"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

type Summary = {
  ok: boolean
  month: string
  net_savings_usd: number
  gross_savings_usd: number
  costs_usd: number
  actions: number
  unmeasurable_actions: number
}

type DailyPoint = {
  day: string
  net: number
  gross: number
  costs: number
  kwhShifted: number
  actions: number
  unmeasurable: number
}

const money = (n: number | undefined | null) =>
  n == null ? "—" : `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`

// Savings answers "what did Elevate do for me" — deliberately SEPARATE from the
// cost chart ("what am I spending"). The primary visual is a cumulative net
// line: the climbing total across the month is what builds trust. Costs are
// shown alongside gross on purpose — pre-cooling spends at off-peak to dodge
// on-peak, and hiding that half would make the headline dishonest.
export function SavingsSection() {
  const { data: summary } = useSWR<Summary>("/api/savings/summary", fetcher, { refreshInterval: 60000 })
  const { data: dailyData } = useSWR<{ ok: boolean; days: DailyPoint[] }>("/api/savings/daily", fetcher, {
    refreshInterval: 60000,
  })
  const [open, setOpen] = useState(false)

  // Only surface the section once there's a measured month worth showing.
  if (!summary || summary.actions === 0) return null

  const days = dailyData?.days ?? []
  const kwhShifted = days.reduce((s, d) => s + d.kwhShifted, 0)
  const net = summary.net_savings_usd

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
            <PiggyBank className="h-5 w-5 text-ok" />
          </span>
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-foreground">Your savings</h3>
            <p className="truncate text-xs text-muted">Measured from real power data this month.</p>
          </div>
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
        <div
          className={`shrink-0 rounded-xl border px-3 py-1.5 text-right ${
            net < 0 ? "border-warn/30 bg-warn/10" : "border-ok/30 bg-ok/10"
          }`}
        >
          <p className="text-[10px] uppercase tracking-wide text-muted">Net this month</p>
          <p className={`text-sm font-bold tabular-nums ${net < 0 ? "text-warn" : "text-ok"}`}>{money(net)}</p>
        </div>
      </div>

      {open ? (
        <>
          <CumulativeChart days={days} />

          {/* The honest three-way breakdown. */}
          <div className="mt-4 grid grid-cols-3 gap-3">
            <Figure label="Gross savings" value={money(summary.gross_savings_usd)} tone="ok" hint="earned by coasting" />
            <Figure label="Costs" value={money(summary.costs_usd)} tone="muted" hint="spent pre-cooling" />
            <Figure
              label="Net"
              value={money(summary.net_savings_usd)}
              tone={net < 0 ? "warn" : "ok"}
              hint="honest total"
            />
          </div>

          {kwhShifted > 0 ? (
            <p className="mt-3 text-center text-xs text-muted-foreground">
              Moved{" "}
              <span className="font-semibold tabular-nums text-foreground">{kwhShifted.toFixed(1)} kWh</span> out
              of peak hours by coasting.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
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
  tone: "ok" | "warn" | "muted"
  hint: string
}) {
  const color = tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : "text-muted-foreground"
  return (
    <div className="rounded-xl border border-border bg-elevated p-3 text-center">
      <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-0.5 text-base font-bold tabular-nums ${color}`}>{value}</p>
      <p className="mt-0.5 text-[10px] text-muted">{hint}</p>
    </div>
  )
}

// Cumulative net-savings line across the month, with a soft area fill and a
// zero baseline (so a dip into net-negative reads honestly). Pure SVG, matching
// the cost/comfort charts' token-driven styling.
function CumulativeChart({ days }: { days: DailyPoint[] }) {
  if (days.length === 0) {
    return (
      <p className="mt-3 rounded-lg border border-border bg-elevated px-4 py-8 text-center text-sm text-muted">
        Still measuring — your savings will chart here as automations run this month.
      </p>
    )
  }

  // Running cumulative total, oldest → newest.
  let run = 0
  const cum = days.map((d) => {
    run += d.net
    return { day: d.day, value: Math.round(run * 100) / 100 }
  })

  const W = 328
  const H = 132
  const padX = 8
  const padTop = 16
  const padBottom = 20
  const plotW = W - padX * 2
  const plotH = H - padTop - padBottom

  const values = cum.map((c) => c.value)
  const minV = Math.min(0, ...values)
  const maxV = Math.max(0, ...values)
  const span = maxV - minV || 1

  const n = cum.length
  const x = (i: number) => (n === 1 ? padX + plotW / 2 : padX + (i / (n - 1)) * plotW)
  const y = (v: number) => padTop + (1 - (v - minV) / span) * plotH
  const baselineY = y(0)

  const linePts = cum.map((c, i) => `${x(i)},${y(c.value)}`)
  const linePath = `M ${linePts.join(" L ")}`
  const areaPath = `M ${x(0)},${baselineY} L ${linePts.join(" L ")} L ${x(n - 1)},${baselineY} Z`

  const last = cum[n - 1]
  const dayLabel = (iso: string) => String(Number(iso.slice(8, 10)))

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="mt-3 h-auto w-full"
      role="img"
      aria-label="Cumulative net savings this month"
      preserveAspectRatio="xMidYMid meet"
    >
      {/* zero baseline */}
      <line x1={padX} y1={baselineY} x2={W - padX} y2={baselineY} stroke="var(--color-border)" strokeWidth={1} />
      {/* area under the climbing line */}
      <path d={areaPath} fill="var(--color-ok)" fillOpacity={0.12} />
      {/* the line itself */}
      <path
        d={linePath}
        fill="none"
        stroke="var(--color-ok)"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* endpoint dot */}
      <circle cx={x(n - 1)} cy={y(last.value)} r={3} fill="var(--color-ok)" />
      {/* endpoint value */}
      <text
        x={Math.min(x(n - 1), W - padX - 2)}
        y={Math.max(y(last.value) - 7, 10)}
        textAnchor="end"
        fontSize={11}
        fontWeight={600}
        fill="var(--color-foreground)"
      >
        {money(last.value)}
      </text>
      {/* first + last day labels */}
      <text x={padX} y={H - 6} fontSize={10} fill="var(--color-muted)">
        {dayLabel(cum[0].day)}
      </text>
      {n > 1 ? (
        <text x={W - padX} y={H - 6} textAnchor="end" fontSize={10} fill="var(--color-muted)">
          {dayLabel(last.day)}
        </text>
      ) : null}
    </svg>
  )
}
