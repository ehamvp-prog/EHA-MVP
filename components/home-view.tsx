"use client"

import { useEffect, useState } from "react"
import useSWR from "swr"
import { DollarSign, Thermometer, Sun, Home as HomeIcon, Smile, RefreshCw } from "lucide-react"
import { ComfortProfilePanel, HappyNumberPanel } from "./comfort-profile"
import { NestCard } from "./nest-card"
import { AutomationJournalCard } from "./automation-journal"
import { SavingsSection } from "./savings-section"
import { ComfortChart } from "./comfort-chart"
import { EfficiencyChart } from "./efficiency-chart"
import { FilterHealthCard } from "./filter-health-card"
import { chicagoParts } from "@/lib/chicago-time"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

// Shape pulled from /api/compute/live — same payload Tech View uses.
type Computed = {
  return_temp_f: number | null
  return_rh: number | null
  supply_temp_f: number | null
  supply_rh: number | null
  static_pressure_inwc: number | null
  live_eer: number | null
  measured_seer2_estimate: number | null
  cost_per_hour: number | null
  rate_per_kwh: number
  outdoor_temp_f: number | null
  efficiency_color: string
  system_state: "cooling" | "fan_only" | "off" | "fault"
  system_running: boolean
  sensor_faults: { code: string; severity: "warn" | "fault"; message: string }[]
  diagnostics: { ratedSeer2: number | null }
}

function money(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return `$${n.toFixed(digits)}`
}

// ---- Plain-language translators -------------------------------------------

// Friendly top-of-screen system status (emojis requested for this headline).
function systemStatus(c: Computed | undefined): { title: string; tone: string; dot: string } {
  if (!c) return { title: "Connecting to your system…", tone: "text-muted-foreground", dot: "bg-muted" }
  const hardFault = c.sensor_faults?.some((f) => f.severity === "fault")
  if (c.system_state === "fault" && hardFault)
    return { title: "Something looks off — tap for details", tone: "text-warn", dot: "bg-warn" }
  if (c.system_state === "cooling")
    return { title: "Your system is on and cooling", tone: "text-muted-foreground", dot: "bg-ok" }
  if (c.system_state === "fan_only")
    return { title: "Your fan is running, circulating air", tone: "text-muted-foreground", dot: "bg-ok" }
  return { title: "Your system is off", tone: "text-muted-foreground", dot: "bg-muted" }
}

// Humidity → a nature comparison, driven by the live indoor RH value.
function humidityComfort(rh: number | null): { label: string; tone: string } {
  if (rh == null) return { label: "Humidity unavailable", tone: "text-muted-foreground" }
  if (rh < 30) return { label: "Dry — like crisp desert air", tone: "text-accent" }
  if (rh < 45) return { label: "Comfortable — like a mountain morning", tone: "text-ok" }
  if (rh < 55) return { label: "Comfortable — like fresh spring air", tone: "text-ok" }
  if (rh < 65) return { label: "A little humid — like a mild afternoon", tone: "text-warn" }
  if (rh < 80) return { label: "Humid — like a summer afternoon", tone: "text-warn" }
  return { label: "Very humid — tropical air", tone: "text-orange" }
}

// Outdoor reassurance copy pulled from the live outdoor temp.
function outdoorMessage(t: number | null): string {
  if (t == null) return "Outdoor conditions are unavailable right now."
  const r = Math.round(t)
  if (r >= 95) return `It's ${r}°F outside. Your system is working hard today — that's completely normal in this heat.`
  if (r >= 85) return `It's ${r}°F outside. Your system is working hard today — that's normal for this heat.`
  if (r >= 70) return `It's ${r}°F outside — a warm day your system handles comfortably.`
  return `It's ${r}°F outside — mild conditions, an easy day for your system.`
}

export function HomeView() {
  const { data } = useSWR<{ ok: boolean; computed: Computed }>("/api/compute/live", fetcher, {
    refreshInterval: 5000,
  })
  const { data: cost } = useSWR<{ total_with_base_charge: number; energy_cost: number; customer_charge: number }>(
    "/api/cost/summary",
    fetcher,
    { refreshInterval: 15000 },
  )
  const { data: history } = useSWR<{ week_to_date: number; today: number }>(
    "/api/cost/history",
    fetcher,
    { refreshInterval: 60000 },
  )
  // Persist on a cadence too, so Home View alone keeps history growing.
  useEffect(() => {
    const tick = () => fetch("/api/compute/persist", { method: "POST" }).catch(() => {})
    tick()
    const id = setInterval(tick, 60000)
    return () => clearInterval(id)
  }, [])

  // NOTE: The automation engine is NOT triggered from the client. It runs
  // server-side on a Supabase pg_cron schedule (every 5 min) so it works even
  // when the app is closed. Home View only READS the journal + live comfort
  // numbers through the normal SWR fetches below.

  const [historyOpen, setHistoryOpen] = useState(false)
  const [subTab, setSubTab] = useState<"home" | "comfort">("home")
  const c = data?.computed

  const status = systemStatus(c)
  const humidity = humidityComfort(c?.return_rh ?? null)

  return (
    <div className="flex flex-col gap-4">
      {/* Sub-tabs: live dashboard vs comfort profile */}
      <div
        className="flex items-center gap-1 rounded-2xl border border-border bg-card p-1"
        role="tablist"
        aria-label="Home sections"
      >
        <SubTab active={subTab === "home"} onClick={() => setSubTab("home")} icon={<HomeIcon className="h-4 w-4" />}>
          My Home
        </SubTab>
        <SubTab active={subTab === "comfort"} onClick={() => setSubTab("comfort")} icon={<Smile className="h-4 w-4" />}>
          Comfort Profile
        </SubTab>
      </div>

      {subTab === "comfort" ? (
        <ComfortProfilePanel />
      ) : (
        <section aria-label="Home view" className="flex flex-col gap-4">
          {/* 1. System status — quiet, inconspicuous line */}
          <div className="flex items-center justify-center gap-2 pt-1">
            <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${status.dot}`} aria-hidden="true" />
            <p className={`text-sm font-medium ${status.tone}`}>{status.title}</p>
          </div>

          {/* 2. Happy Number — live comfort HUD */}
          <HappyNumberPanel
            liveTempF={c?.return_temp_f ?? null}
            liveRh={c?.return_rh ?? null}
            systemRunning={!!c?.system_running}
          />

          {/* 2. Savings — measured value, kept high while attention is fresh */}
          <SavingsSection />

      {/* 3. What you're spending — real dollars against real TOU rates */}
      <div className="rounded-2xl border border-border bg-card p-5 shadow-lg shadow-black/40">
        <SectionHeader icon={<DollarSign className="h-5 w-5 text-ok" />} title="What you're spending" />
        <div className="grid grid-cols-3 gap-3">
          <CostTile label="Right now" value={c?.cost_per_hour != null ? `${money(c.cost_per_hour)}` : "—"} sub="per hour" big />
          <CostTile label="This week" value={money(history?.week_to_date)} sub="energy used" />
          <CostTile label="This month" value={money(cost?.total_with_base_charge)} sub="so far" />
        </div>
        <p className="mt-3 text-center text-xs text-muted-foreground">
          Includes your {money(cost?.customer_charge)} monthly Evergy base charge.
        </p>

        {/* Collapsible daily history */}
        <button
          type="button"
          onClick={() => setHistoryOpen((v) => !v)}
          aria-expanded={historyOpen}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-elevated px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {historyOpen ? "Hide" : "Show"} daily spending
          <span aria-hidden className={`transition-transform ${historyOpen ? "rotate-180" : ""}`}>
            ⌄
          </span>
        </button>
        {historyOpen ? (
          <CostChart />
        ) : null}
      </div>

          {/* 4. Comfort history — standalone chart, proves comfort held while saving */}
          <ComfortChart />

          {/* 5. Efficiency history — measured EER against nameplate, minute by minute */}
          <EfficiencyChart />

          {/* 6. Automation journal — self-hides until there's history */}
          <AutomationJournalCard />

          {/* 7. Filter health — needle gauge driven by filter LOAD ratio */}
          <FilterHealthCard staticInWc={c?.static_pressure_inwc ?? null} />

          {/* 8. Nest thermostat — readings up top, controls expandable */}
          <NestCard />

          {/* 9. Air & Conditions — indoor air + outdoor context, combined at the bottom */}
          <div className="rounded-2xl border border-border bg-card p-5 shadow-lg shadow-black/40">
            <SectionHeader icon={<Thermometer className="h-5 w-5 text-primary" />} title="Air & Conditions" />
            <div className="grid grid-cols-2 gap-3">
              <TempTile
                label="Cool air coming out"
                value={c?.supply_temp_f != null ? `${Math.round(c.supply_temp_f)}°F` : "—"}
              />
              <TempTile
                label="Warm air going in"
                value={c?.return_temp_f != null ? `${Math.round(c.return_temp_f)}°F` : "—"}
              />
            </div>
            <div className="mt-3 rounded-xl border border-border bg-elevated p-4 text-center">
              <p className="text-xs uppercase tracking-wider text-muted">Indoor humidity</p>
              <p className={`mt-1 text-base font-semibold text-pretty ${humidity.tone}`}>{humidity.label}</p>
            </div>
            <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-border bg-elevated p-4">
              <Sun className="mt-0.5 h-5 w-5 shrink-0 text-warn" aria-hidden />
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-wider text-muted">Outside your home</p>
                <p className="mt-1 text-sm text-muted-foreground text-pretty">
                  {outdoorMessage(c?.outdoor_temp_f ?? null)}
                </p>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}

function SubTab({
  children,
  active,
  onClick,
  icon,
}: {
  children: React.ReactNode
  active: boolean
  onClick: () => void
  icon: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors ${
        active ? "bg-primary text-primary-foreground" : "text-muted hover:text-foreground"
      }`}
    >
      {icon}
      {children}
    </button>
  )
}

// Section header with a soft icon badge, matching the comfort cards.
function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-elevated">
        {icon}
      </span>
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
    </div>
  )
}

function CostTile({
  label,
  value,
  sub,
  big,
}: {
  label: string
  value: string
  sub: string
  big?: boolean
}) {
  return (
    <div className="rounded-xl border border-border bg-elevated p-3 text-center">
      <p className="font-mono text-xs uppercase tracking-wider text-muted">{label}</p>
      <p className={`mt-1 font-semibold tabular-nums text-foreground ${big ? "text-2xl" : "text-xl"}`}>
        {value}
      </p>
      <p className="mt-0.5 text-[10px] text-muted">{sub}</p>
    </div>
  )
}

function TempTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-elevated p-4 text-center">
      <p className="text-xs uppercase tracking-wider text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{value}</p>
    </div>
  )
}

// ---- Cost-over-time chart -------------------------------------------------
// Three granularities (Daily/Weekly/Monthly), labeled SVG axes, and TOU rate
// bands behind the daily bars. Blue accent when expanded, matching the app.

type ChartMode = "daily" | "weekly" | "monthly"
type Bar = { key: string; label: string; show: boolean; value: number; tou?: string }

// Round a value up to a clean axis maximum (1/2/5 × 10ⁿ).
function niceMax(v: number): number {
  if (v <= 0) return 0.1
  const pow = Math.pow(10, Math.floor(Math.log10(v)))
  const n = v / pow
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return step * pow
}

function hourLabel(h: number): string {
  if (h === 0) return "12a"
  if (h === 12) return "12p"
  return h < 12 ? `${h}a` : `${h - 12}p`
}

// Local YYYY-MM-DD (Central) → short weekday + day, e.g. "Sat 27".
function dayShortLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getUTCDay()]
  return `${wd} ${d}`
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

type PeriodResponse = {
  anchor: string
  year: number
  month: number
  day: number
  weekOfMonth: number
  hours: { hour: number; spend: number; tou: string }[]
  week: { day: string; spend: number }[]
  weeks: { week: number; startDay: string; endDay: string; spend: number }[]
  monthTotal: number
  availableMonths: { year: number; month: number }[]
}

function pad2(n: number) {
  return String(n).padStart(2, "0")
}

function CostChart() {
  const [mode, setMode] = useState<ChartMode>("daily")

  // "Today" in America/Chicago — the reset target and default anchor. Uses a
  // real DST-aware conversion (the ledger data is Chicago-bucketed); the old
  // fixed -6h offset double-shifted it and was wrong during CDT.
  const { year: todayY, month: todayM, day: todayD } = chicagoParts()

  // One shared calendar anchor drives ALL three tabs. Changing the month or
  // year snaps the day back to the 1st (so "just a month" reads the start of
  // the month for the daily/weekly views).
  const [selYear, setSelYear] = useState(todayY)
  const [selMonth, setSelMonth] = useState(todayM)
  const [selDay, setSelDay] = useState(todayD)

  const daysInMonth = new Date(Date.UTC(selYear, selMonth, 0)).getUTCDate()
  const safeDay = Math.min(selDay, daysInMonth)
  const anchorIso = `${selYear}-${pad2(selMonth)}-${pad2(safeDay)}`

  // Single fetch returns hourly + weekly + monthly for the anchor, all
  // zero-filled server-side so empty/future buckets still render as 0.
  const { data, mutate } = useSWR<PeriodResponse>(
    `/api/cost/period?date=${anchorIso}`,
    fetcher,
    { refreshInterval: 60000 },
  )

  const availableMonths = data?.availableMonths ?? [{ year: selYear, month: selMonth }]
  const years = Array.from(new Set(availableMonths.map((a) => a.year))).sort((a, b) => b - a)
  const monthsForYear = availableMonths.filter((a) => a.year === selYear).map((a) => a.month)

  const isCurrent = selYear === todayY && selMonth === todayM && safeDay === todayD

  // Bring the calendar (and data) back to the latest live readings.
  function resetToNow() {
    setSelYear(todayY)
    setSelMonth(todayM)
    setSelDay(todayD)
    mutate()
  }

  // Anchor weekday (Central) decides on-peak hours for the daily TOU bands.
  const anchorWeekday = new Date(Date.UTC(selYear, selMonth - 1, safeDay)).getUTCDay()
  const isWeekday = anchorWeekday >= 1 && anchorWeekday <= 5

  const monthLabel = `${MONTH_NAMES[selMonth - 1]} ${selYear}`
  const title =
    mode === "daily"
      ? `${MONTH_NAMES[selMonth - 1]} ${safeDay}, ${selYear} — hourly spending`
      : mode === "weekly"
        ? `Week ${data?.weekOfMonth ?? Math.min(Math.ceil(safeDay / 7), 5)} of ${monthLabel} — daily spending`
        : `${monthLabel} — weekly spending`

  // Build the (always zero-filled) bar set for the active tab.
  let bars: Bar[] = []
  if (mode === "daily") {
    const byHour = new Map((data?.hours ?? []).map((h) => [h.hour, h]))
    bars = Array.from({ length: 24 }, (_, h) => {
      const tou =
        h < 6 ? "super_off_peak" : isWeekday && h >= 16 && h < 20 ? "on_peak" : "off_peak"
      return {
        key: `h${h}`,
        label: hourLabel(h),
        show: h % 6 === 0 || h === 23,
        value: byHour.get(h)?.spend ?? 0,
        tou,
      }
    })
  } else if (mode === "weekly") {
    bars = (data?.week ?? []).map((d) => ({
      key: d.day,
      label: dayShortLabel(d.day),
      show: true,
      value: d.spend,
    }))
  } else {
    bars = (data?.weeks ?? []).map((w) => ({
      key: `w${w.week}`,
      label: `Wk ${w.week}`,
      show: true,
      value: w.spend,
    }))
  }

  const periodTotal =
    mode === "monthly" ? (data?.monthTotal ?? 0) : bars.reduce((s, b) => s + b.value, 0)
  const totalLabel = mode === "daily" ? "Day total" : mode === "weekly" ? "Week total" : "Month total"

  return (
    <div className="mt-3 rounded-xl border border-accent/40 bg-elevated p-4">
      {/* Granularity toggle */}
      <div
        className="mb-3 flex items-center gap-1 rounded-lg border border-border bg-card p-0.5"
        role="tablist"
        aria-label="Spending range"
      >
        {(["daily", "weekly", "monthly"] as ChartMode[]).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={`flex-1 rounded-md px-2 py-1 text-xs font-medium capitalize transition-colors ${
              mode === m ? "bg-accent text-accent-foreground" : "text-muted hover:text-foreground"
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      {/* Shared calendar: month + day + year apply to every tab, plus a
          refresh button that jumps back to the latest readings. */}
      <div className="mb-3 flex items-center gap-2">
        <select
          aria-label="Select month"
          value={selMonth}
          onChange={(e) => {
            setSelMonth(Number(e.target.value))
            setSelDay(1)
          }}
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
          value={safeDay}
          onChange={(e) => setSelDay(Number(e.target.value))}
          className="w-16 rounded-lg border border-border bg-card px-2 py-1.5 text-xs font-medium text-foreground outline-none focus:border-accent"
        >
          {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <select
          aria-label="Select year"
          value={selYear}
          onChange={(e) => {
            const y = Number(e.target.value)
            setSelYear(y)
            const valid = availableMonths.filter((a) => a.year === y).map((a) => a.month)
            if (valid.length && !valid.includes(selMonth)) setSelMonth(Math.max(...valid))
            setSelDay(1)
          }}
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
          onClick={resetToNow}
          disabled={isCurrent}
          aria-label="Refresh to current readings"
          title="Back to current readings"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      <h4 className="mb-2 text-center text-sm font-semibold text-foreground text-pretty">{title}</h4>

      {!data ? (
        <p className="rounded-lg border border-border bg-card px-4 py-8 text-center text-sm text-muted">
          Loading…
        </p>
      ) : (
        <>
          <BarChartSvg bars={bars} digits={2} showBands={mode === "daily"} />
          {mode === "daily" ? <TouLegend /> : null}
          <p className="mt-2 text-center text-xs text-muted">
            {totalLabel}:{" "}
            <span className="font-semibold text-foreground tabular-nums">${periodTotal.toFixed(2)}</span>
            {periodTotal === 0 ? <span className="ml-1 text-muted">· no spending recorded</span> : null}
          </p>
        </>
      )}
    </div>
  )
}

// Pure SVG bar chart with labeled $ y-axis, time x-axis, and optional TOU bands.
function BarChartSvg({
  bars,
  digits,
  showBands,
}: {
  bars: Bar[]
  digits: number
  showBands: boolean
}) {
  const W = 340
  const H = 200
  const ml = 38
  const mr = 8
  const mt = 10
  const mb = 22
  const plotX0 = ml
  const plotX1 = W - mr
  const plotW = plotX1 - plotX0
  const plotY0 = mt
  const plotY1 = H - mb
  const plotH = plotY1 - plotY0

  const rawMax = Math.max(...bars.map((b) => b.value), 0)
  const yMax = niceMax(rawMax)
  const n = bars.length
  const slot = plotW / n
  const barW = Math.max(slot * 0.62, 2)
  const yOf = (v: number) => plotY1 - (v / yMax) * plotH

  const ticks = [0, yMax / 2, yMax]
  const bandColor: Record<string, string> = {
    super_off_peak: "rgba(41, 209, 126, 0.10)",
    on_peak: "rgba(245, 128, 61, 0.12)",
    off_peak: "transparent",
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      role="img"
      aria-label="Spending bar chart"
      style={{ height: "auto" }}
    >
      {/* TOU rate bands behind bars (daily only) */}
      {showBands &&
        bars.map((b, i) => {
          const fill = bandColor[b.tou ?? "off_peak"]
          if (fill === "transparent") return null
          return (
            <rect
              key={`band-${b.key}`}
              x={plotX0 + i * slot}
              y={plotY0}
              width={slot}
              height={plotH}
              fill={fill}
            />
          )
        })}

      {/* Y gridlines + $ labels */}
      {ticks.map((t, i) => {
        const y = yOf(t)
        return (
          <g key={`tick-${i}`}>
            <line x1={plotX0} y1={y} x2={plotX1} y2={y} stroke="var(--color-border)" strokeWidth={1} />
            <text
              x={plotX0 - 5}
              y={y + 3}
              textAnchor="end"
              fontSize={9}
              fill="var(--color-muted)"
            >
              {`$${t.toFixed(digits)}`}
            </text>
          </g>
        )
      })}

      {/* Bars */}
      {bars.map((b, i) => {
        const x = plotX0 + i * slot + (slot - barW) / 2
        const y = yOf(b.value)
        const h = b.value > 0 ? Math.max(plotY1 - y, 1.5) : 0
        return (
          <rect
            key={b.key}
            x={x}
            y={y}
            width={barW}
            height={h}
            rx={1.5}
            fill="var(--color-accent)"
          >
            <title>{`${b.label}: $${b.value.toFixed(Math.max(digits, 2))}`}</title>
          </rect>
        )
      })}

      {/* X axis line */}
      <line x1={plotX0} y1={plotY1} x2={plotX1} y2={plotY1} stroke="var(--color-border)" strokeWidth={1} />

      {/* X labels (subset where show=true) */}
      {bars.map((b, i) =>
        b.show ? (
          <text
            key={`xl-${b.key}`}
            x={plotX0 + i * slot + slot / 2}
            y={plotY1 + 13}
            textAnchor="middle"
            fontSize={9}
            fill="var(--color-muted)"
          >
            {b.label}
          </text>
        ) : null,
      )}
    </svg>
  )
}

function TouLegend() {
  return (
    <div className="mt-2 flex items-center justify-center gap-4 text-[10px] text-muted">
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: "rgba(41, 209, 126, 0.35)" }} aria-hidden />
        Super off-peak
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-sm border border-border" aria-hidden />
        Off-peak
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: "rgba(245, 128, 61, 0.4)" }} aria-hidden />
        On-peak
      </span>
    </div>
  )
}
