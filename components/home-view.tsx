"use client"

import { useEffect, useState } from "react"
import useSWR from "swr"

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
function systemStatus(c: Computed | undefined): { title: string; tone: string } {
  if (!c) return { title: "Connecting to your system…", tone: "text-muted-foreground" }
  const hardFault = c.sensor_faults?.some((f) => f.severity === "fault")
  if (c.system_state === "fault" && hardFault)
    return { title: "Something looks off — tap for details 🟠", tone: "text-orange" }
  if (c.system_state === "cooling")
    return { title: "Your system is on and cooling 🟢", tone: "text-ok" }
  if (c.system_state === "fan_only")
    return { title: "Your fan is running, circulating air 🟢", tone: "text-ok" }
  return { title: "Your system is off ⚪", tone: "text-muted-foreground" }
}

// Efficiency verdict in soft homeowner language.
function efficiencyLabel(color: string): { label: string; tone: string; dot: string } {
  switch (color) {
    case "green":
      return { label: "Running great", tone: "text-ok", dot: "bg-ok glow-ok" }
    case "yellow":
      return { label: "Slightly off", tone: "text-warn", dot: "bg-warn glow-warn" }
    case "orange":
      return { label: "Worth a look", tone: "text-orange", dot: "bg-orange glow-orange" }
    case "red":
      return { label: "Needs attention", tone: "text-bad", dot: "bg-bad glow-bad" }
    default:
      return { label: "Getting to know your system", tone: "text-muted-foreground", dot: "bg-primary glow-primary" }
  }
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

// Static pressure → filter / airflow health. Thresholds mirror the engine's
// ECM rated-static limit (~0.8" WC) so this stays consistent with the model.
function airflowHealth(staticInWc: number | null): { label: string; tone: string; dot: string } {
  if (staticInWc == null)
    return { label: "Airflow reading unavailable", tone: "text-muted-foreground", dot: "bg-muted" }
  if (staticInWc <= 0.8)
    return { label: "Airflow is good", tone: "text-ok", dot: "bg-ok glow-ok" }
  if (staticInWc <= 1.0)
    return { label: "Airflow slightly restricted — check your filter", tone: "text-warn", dot: "bg-warn glow-warn" }
  return { label: "Airflow restricted — filter change needed", tone: "text-orange", dot: "bg-orange glow-orange" }
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
  const { data: cost } = useSWR<{ accumulated_cost: number; customer_charge: number }>(
    "/api/cost/summary",
    fetcher,
    { refreshInterval: 15000 },
  )
  const { data: history } = useSWR<{
    days: { day: string; spend: number }[]
    week_to_date: number
    today: number
  }>("/api/cost/history", fetcher, { refreshInterval: 60000 })

  // Persist on a cadence too, so Home View alone keeps history growing.
  useEffect(() => {
    const tick = () => fetch("/api/compute/persist", { method: "POST" }).catch(() => {})
    tick()
    const id = setInterval(tick, 60000)
    return () => clearInterval(id)
  }, [])

  const [historyOpen, setHistoryOpen] = useState(false)
  const c = data?.computed

  const status = systemStatus(c)
  const eff = efficiencyLabel(c?.efficiency_color ?? "learning")
  const humidity = humidityComfort(c?.return_rh ?? null)
  const airflow = airflowHealth(c?.static_pressure_inwc ?? null)
  const ratedSeer2 = c?.diagnostics?.ratedSeer2 ?? null

  return (
    <section aria-label="Home view" className="flex flex-col gap-4">
      {/* 1. Friendly system status headline */}
      <div className="rounded-2xl border border-border bg-card p-6 text-center shadow-lg shadow-black/40">
        <h2 className={`text-2xl font-semibold text-balance ${status.tone}`}>{status.title}</h2>
      </div>

      {/* 2. Cost — the centerpiece */}
      <div className="rounded-2xl border border-border bg-card p-5 shadow-lg shadow-black/40">
        <h3 className="mb-4 text-base font-semibold text-foreground">What you&apos;re spending</h3>
        <div className="grid grid-cols-3 gap-3">
          <CostTile label="Right now" value={c?.cost_per_hour != null ? `${money(c.cost_per_hour)}` : "—"} sub="per hour" big />
          <CostTile label="This week" value={money(history?.week_to_date)} sub="energy used" />
          <CostTile label="This month" value={money(cost?.accumulated_cost)} sub="so far" />
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
        {historyOpen ? <CostHistory days={history?.days ?? []} /> : null}
      </div>

      {/* 3. Efficiency */}
      <div className="rounded-2xl border border-border bg-card p-5 shadow-lg shadow-black/40">
        <div className="mb-3 flex items-center gap-3">
          <span className={`h-3.5 w-3.5 shrink-0 rounded-full ${eff.dot}`} aria-hidden />
          <h3 className="text-base font-semibold text-foreground">
            How efficiently you&apos;re running: <span className={eff.tone}>{eff.label}</span>
          </h3>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-border bg-elevated p-4">
            <p className="text-sm text-muted-foreground text-pretty">
              Right now your system is running at{" "}
              <span className="font-semibold text-foreground">
                {c?.live_eer != null ? c.live_eer.toFixed(1) : "—"}
              </span>{" "}
              efficiency.
            </p>
          </div>
          <div className="rounded-xl border border-border bg-elevated p-4">
            <p className="text-sm text-muted-foreground text-pretty">
              Your system&apos;s overall efficiency rating:{" "}
              <span className="font-semibold text-foreground">
                {c?.measured_seer2_estimate != null ? c.measured_seer2_estimate.toFixed(1) : "—"}
              </span>
              {ratedSeer2 ? ` (rated ${ratedSeer2}).` : "."}
            </p>
          </div>
        </div>
        <p className="mt-3 text-center text-xs text-muted-foreground">
          A new system is typically rated 15–18. Higher is better.
        </p>
      </div>

      {/* 4. Temperature & Humidity */}
      <div className="rounded-2xl border border-border bg-card p-5 shadow-lg shadow-black/40">
        <h3 className="mb-4 text-base font-semibold text-foreground">Your air right now</h3>
        <div className="grid grid-cols-2 gap-3">
          <TempTile label="Cool air coming out" value={c?.supply_temp_f != null ? `${Math.round(c.supply_temp_f)}°F` : "—"} />
          <TempTile label="Warm air going in" value={c?.return_temp_f != null ? `${Math.round(c.return_temp_f)}°F` : "—"} />
        </div>
        <div className="mt-3 rounded-xl border border-border bg-elevated p-4 text-center">
          <p className="text-xs uppercase tracking-wider text-muted">Indoor humidity</p>
          <p className={`mt-1 text-base font-semibold text-pretty ${humidity.tone}`}>{humidity.label}</p>
        </div>
      </div>

      {/* 5. Static pressure → filter health */}
      <div className="rounded-2xl border border-border bg-card p-5 shadow-lg shadow-black/40">
        <h3 className="mb-3 text-base font-semibold text-foreground">Filter &amp; airflow</h3>
        <div className="flex items-center gap-3 rounded-xl border border-border bg-elevated p-4">
          <span className={`h-4 w-4 shrink-0 rounded-full ${airflow.dot}`} aria-hidden />
          <div>
            <p className={`text-base font-semibold text-pretty ${airflow.tone}`}>{airflow.label}</p>
            <p className="mt-0.5 text-xs text-muted">
              {c?.static_pressure_inwc != null
                ? `Static pressure: ${c.static_pressure_inwc.toFixed(2)}" WC`
                : "Awaiting reading"}
            </p>
          </div>
        </div>
      </div>

      {/* 6. Outdoor conditions */}
      <div className="rounded-2xl border border-border bg-card p-5 shadow-lg shadow-black/40">
        <h3 className="mb-3 text-base font-semibold text-foreground">Outside your home</h3>
        <p className="text-sm text-muted-foreground text-pretty">{outdoorMessage(c?.outdoor_temp_f ?? null)}</p>
      </div>
    </section>
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

// Simple CSS bar chart of daily energy spend. Blue accent (interactive color)
// when expanded, consistent with the rest of the app.
function CostHistory({ days }: { days: { day: string; spend: number }[] }) {
  if (days.length === 0) {
    return (
      <p className="mt-3 rounded-xl border border-border bg-elevated px-4 py-6 text-center text-sm text-muted">
        Daily spending will appear here as your system runs over the coming days.
      </p>
    )
  }
  const max = Math.max(...days.map((d) => d.spend), 0.01)
  const dayWord = days.length === 1 ? "day" : "days"
  return (
    <div className="mt-3 rounded-xl border border-accent/30 bg-elevated p-4">
      {/* Bar track — bars are direct children of the fixed-height row so their
          percentage heights resolve against it. */}
      <div className="flex items-end gap-1" style={{ height: 120 }}>
        {days.map((d) => {
          const pct = Math.max((d.spend / max) * 100, 3)
          return (
            <div
              key={d.day}
              className="flex-1 rounded-t bg-accent transition-all"
              style={{ height: `${pct}%` }}
              title={`${d.day}: ${money(d.spend)}`}
              aria-hidden
            />
          )
        })}
      </div>
      {/* Day labels, aligned 1:1 under the bars */}
      <div className="mt-1 flex gap-1">
        {days.map((d) => (
          <span key={d.day} className="flex-1 text-center text-[9px] tabular-nums text-muted">
            {d.day.slice(8, 10)}
          </span>
        ))}
      </div>
      <p className="mt-2 text-center text-xs text-muted-foreground">
        Daily energy spend (last {days.length} {dayWord})
      </p>
    </div>
  )
}
