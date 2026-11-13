"use client"

import useSWR from "swr"
import { CloudSun } from "lucide-react"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

type Point = {
  day: string
  deltaT: number | null
  run: number
  indoor: number | null
  outdoor: number | null
  heatPerMin: number | null
  complete: boolean
  counted: boolean
}
type Resp = {
  ok: boolean
  mode: "heating" | "cooling"
  status: "learning" | "early" | "reliable"
  run_days: number
  min_days: number
  reliable_days: number
  points: Point[]
  fit: { slope: number; intercept: number; r2: number; n: number } | null
  line_outdoor: { slope: number; intercept: number } | null
  indoor_avg_f: number | null
  counted_outdoor_range: [number, number] | null
  no_run_outdoor_f: number | null
  nonstop_outdoor_f: number | null
  nonstop_source: "hourly" | "line" | null
  not_counted_days: number
  yesterday: { day: string; actual: number; expected: number | null; pct: number | null; outdoor: number | null; indoor: number | null } | null
  last7: { days: number; actual: number; expected: number | null; pct: number | null }
  heat_per_min: { recent_btu: number | null; avg_btu: number | null } | null
  learning_reason: "few_days" | "inconsistent" | null
}

function hm(min: number | null | undefined) {
  if (min == null) return "—"
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  return h ? `${h} hr ${m} min` : `${m} min`
}

// "Yesterday", or the date of the last day that counted (e.g. the AC card in
// November, when the last real cooling day was weeks ago).
function dayLabel(day: string, mode: "heating" | "cooling") {
  const y = new Date(Date.now() - 86400000).toLocaleDateString("en-CA", { timeZone: "America/Chicago" })
  if (day === y) return "Yesterday"
  const d = new Date(`${day}T12:00:00`)
  const md = d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
  return `${md} — last ${mode === "heating" ? "cold" : "hot"} day counted`
}

// Plain-language read of actual vs expected.
function verdict(pct: number | null): { text: string; tone: string } {
  if (pct == null) return { text: "", tone: "text-muted" }
  if (pct > 30) return { text: `${pct}% longer than normal for that weather`, tone: "text-bad" }
  if (pct > 15) return { text: `${pct}% longer than normal for that weather`, tone: "text-warn" }
  if (pct < -15) return { text: `${Math.abs(pct)}% less than normal for that weather`, tone: "text-ok" }
  return { text: "about normal for that weather", tone: "text-ok" }
}

export function WeatherLoadCard({ mode }: { mode: "heating" | "cooling" }) {
  const { data: res } = useSWR<Resp>(`/api/weather-load?mode=${mode}`, fetcher, { refreshInterval: 300000 })
  const data = res?.ok ? res : undefined
  const sys = mode === "heating" ? "furnace" : "AC"
  const accent = mode === "heating" ? "var(--color-orange)" : "var(--color-accent)"
  const y = data?.yesterday
  const yv = verdict(y?.pct ?? null)
  const wv = verdict(data?.last7.pct ?? null)
  const hpm = data?.heat_per_min
  const hpmDrop =
    hpm?.recent_btu != null && hpm.avg_btu != null && hpm.avg_btu > 0
      ? Math.round(((hpm.recent_btu - hpm.avg_btu) / hpm.avg_btu) * 100)
      : null

  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-lg shadow-black/40">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-elevated">
            <CloudSun className="h-5 w-5" style={{ color: accent }} />
          </span>
          <div>
            <h3 className="text-base font-semibold text-foreground">Run time vs. weather</h3>
            <p className="text-xs text-muted">
              How long the {sys} ran for how {mode === "heating" ? "cold" : "hot"} it was
            </p>
          </div>
        </div>
        {data && data.status !== "reliable" ? (
          <span className="shrink-0 rounded-md border border-border bg-elevated px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
            {data.status === "learning" ? "Learning" : "Early"}
          </span>
        ) : null}
      </div>

      {!data ? (
        <p className="py-6 text-center text-sm text-muted">Loading…</p>
      ) : data.status === "learning" ? (
        <>
          <p className="rounded-xl border border-border bg-elevated px-3 py-4 text-center text-sm text-muted text-pretty">
            {data.learning_reason === "inconsistent"
              ? `Learning your house — ${data.run_days} days with ${sys} run time so far, but they don't line up with the weather yet (thermostat changes and mild days mix it up). It needs more steady ${mode === "heating" ? "cold" : "hot"} days before it can say what's normal.`
              : `Learning your house — ${data.run_days} of ${data.min_days} days with ${sys} run time so far. Once it has a week, it can tell you whether the ${sys} ran longer than it should have for the weather.`}
          </p>
          <ScatterChart data={data} accent={accent} />
        </>
      ) : (
        <>
          {y ? (
            <div className="rounded-xl border border-border bg-elevated p-3 text-center">
              <p className="text-[10px] uppercase tracking-wide text-muted">{dayLabel(y.day, mode)}</p>
              <p className="mt-1 text-sm text-foreground text-pretty">
                Ran <span className="font-semibold tabular-nums">{hm(y.actual)}</span>
                {y.expected != null ? (
                  <>
                    {" "}— expected about <span className="font-semibold tabular-nums">{hm(y.expected)}</span>
                  </>
                ) : null}
                {y.outdoor != null ? <span className="text-muted"> ({Math.round(y.outdoor)}°F outside)</span> : null}
              </p>
              {yv.text ? <p className={`mt-0.5 text-sm font-medium ${yv.tone}`}>{yv.text}</p> : null}
              {data.last7.expected != null ? (
                <p className="mt-1 text-xs text-muted">
                  Last {data.last7.days} days: {hm(data.last7.actual)} vs about {hm(data.last7.expected)} expected
                  {wv.text ? <span className={wv.tone}> — {wv.text}</span> : null}
                </p>
              ) : null}
            </div>
          ) : null}

          <ScatterChart data={data} accent={accent} />

          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            <Stat
              label="Per degree"
              value={data.fit ? `${Math.round(data.fit.slope)} min` : "—"}
              sub={`more run time a day for each degree ${mode === "heating" ? "colder" : "hotter"} outside`}
            />
            <Stat
              label="Stops running"
              value={data.no_run_outdoor_f != null ? `${Math.round(data.no_run_outdoor_f)}°F` : "—"}
              sub={
                data.no_run_outdoor_f != null
                  ? `daily average outside, the ${sys} isn't needed`
                  : `not enough mild days yet to tell`
              }
            />
            <Stat
              label="Runs nonstop"
              value={data.nonstop_outdoor_f != null ? `${Math.round(data.nonstop_outdoor_f)}°F` : "—"}
              sub={
                data.nonstop_source === "hourly"
                  ? "outside, it runs the whole hour"
                  : data.nonstop_source === "line"
                    ? "daily average outside, it would run all day"
                    : `hasn't been ${mode === "heating" ? "cold" : "hot"} enough yet to tell`
              }
            />
          </div>

          {mode === "heating" && hpm?.recent_btu != null ? (
            <p
              className={`mt-3 rounded-xl border px-3 py-2 text-center text-xs text-pretty ${
                hpmDrop != null && hpmDrop <= -10 ? "border-warn/40 bg-warn/10 text-warn" : "border-border bg-elevated text-muted"
              }`}
            >
              Heat delivered per burner minute: {hpm.recent_btu.toLocaleString()} BTU lately
              {hpm.avg_btu != null ? ` vs ${hpm.avg_btu.toLocaleString()} average` : ""}.
              {hpmDrop != null && hpmDrop <= -10
                ? " The furnace is putting out less heat than usual — check the filter and blower."
                : " If run time climbs but this stays steady, it's the house losing more heat, not the furnace."}
            </p>
          ) : null}

          <p className="mt-3 text-center text-[11px] text-muted">
            Based on {data.run_days} days{data.fit ? `, line fits ${Math.round(data.fit.r2 * 100)}% of the variation` : ""}.
            {data.status === "early" ? ` Gets more trustworthy after ${data.reliable_days} days.` : ""}
          </p>
        </>
      )}
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl border border-border bg-elevated p-2">
      <p className="font-mono text-[10px] uppercase tracking-wider text-muted">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">{value}</p>
      <p className="text-[10px] leading-tight text-muted">{sub}</p>
    </div>
  )
}

// Dots = days (x: outdoor temperature, daily average; y: hours run).
// Filled dots count toward the line; hollow dots are days with no real load
// (cooling: cooler outside than in; heating: warmer outside than in).
// Last 7 counted days are colored; yesterday is the big dot.
function ScatterChart({ data, accent }: { data: Resp; accent: string }) {
  const pts = data.points.filter((p) => p.complete && p.outdoor != null && (p.run > 0 || p.counted))
  if (pts.length < 2) return null
  const W = 340
  const H = 200
  const ml = 34
  const mr = 8
  const mt = 10
  const mb = 30
  const xs = pts.map((p) => p.outdoor!)
  const ys = pts.map((p) => p.run)
  let x0 = Math.floor(Math.min(...xs) / 5) * 5
  let x1 = Math.ceil(Math.max(...xs) / 5) * 5
  if (x1 - x0 < 10) {
    x0 -= 5
    x1 += 5
  }
  const yMaxRaw = Math.max(60, ...ys)
  const step = yMaxRaw > 360 ? 360 : 60
  const y1 = Math.min(1440, Math.ceil(yMaxRaw / step) * step)
  const px = (x: number) => ml + ((x - x0) / (x1 - x0)) * (W - ml - mr)
  const py = (y: number) => H - mb - (Math.min(y, y1) / y1) * (H - mt - mb)
  const counted = pts.filter((p) => p.counted)
  const recent = new Set(counted.slice(-7).map((p) => p.day))
  const last = counted[counted.length - 1]

  // Draw the line only across the outdoor temps actually counted.
  const lo = data.line_outdoor
  const range = data.counted_outdoor_range
  const line =
    lo && range
      ? (() => {
          const f = (x: number) => Math.max(0, Math.min(1440, lo.slope * x + lo.intercept))
          const a = Math.max(x0, range[0])
          const b = Math.min(x1, range[1])
          if (b <= a) return null
          return { xa: px(a), ya: py(f(a)), xb: px(b), yb: py(f(b)) }
        })()
      : null

  const yTicks = [0, y1 / 2, y1]
  const xTicks = [x0, Math.round((x0 + x1) / 2 / 5) * 5, x1]
  const notCountedLabel = data.mode === "heating" ? "warmer outside than inside" : "cooler outside than inside"
  const hasHollow = pts.some((p) => !p.counted)

  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-3 w-full" role="img" aria-label="Daily run time against outdoor temperature" style={{ height: "auto" }}>
        {yTicks.map((t) => (
          <g key={`y${t}`}>
            <line x1={ml} x2={W - mr} y1={py(t)} y2={py(t)} stroke="var(--color-border)" strokeWidth={1} />
            <text x={ml - 4} y={py(t) + 3} textAnchor="end" fontSize={9} fill="var(--color-muted)">
              {t >= 60 ? `${Math.round(t / 60)}h` : `${t}m`}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={`x${t}`} x={px(t)} y={H - mb + 12} textAnchor="middle" fontSize={9} fill="var(--color-muted)">
            {t}°
          </text>
        ))}
        <text x={(ml + W - mr) / 2} y={H - 4} textAnchor="middle" fontSize={9} fill="var(--color-muted)">
          Outside temperature (°F), daily average
        </text>
        {line ? <line x1={line.xa} y1={line.ya} x2={line.xb} y2={line.yb} stroke={accent} strokeWidth={2} strokeDasharray="5 4" /> : null}
        {pts.map((p) =>
          p.counted ? (
            <circle
              key={p.day}
              cx={px(p.outdoor!)}
              cy={py(p.run)}
              r={last && p.day === last.day ? 5 : 3}
              fill={recent.has(p.day) ? accent : "var(--color-muted)"}
              fillOpacity={recent.has(p.day) ? 0.95 : 0.5}
              stroke={last && p.day === last.day ? "var(--color-foreground)" : "none"}
              strokeWidth={1.5}
            >
              <title>{`${p.day}: ran ${hm(p.run)}, ${Math.round(p.outdoor!)}°F outside`}</title>
            </circle>
          ) : (
            <circle key={p.day} cx={px(p.outdoor!)} cy={py(p.run)} r={3} fill="none" stroke="var(--color-muted)" strokeOpacity={0.6} strokeWidth={1}>
              <title>{`${p.day}: ran ${hm(p.run)}, ${Math.round(p.outdoor!)}°F outside — not counted (${notCountedLabel})`}</title>
            </circle>
          ),
        )}
      </svg>
      {hasHollow ? (
        <p className="mt-1 text-center text-[10px] text-muted">
          Hollow dots = days {notCountedLabel}. Not counted in the line.
        </p>
      ) : null}
    </>
  )
}
