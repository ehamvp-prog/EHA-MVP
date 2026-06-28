"use client"

import { useEffect } from "react"
import useSWR from "swr"
import { RadialGauge } from "./radial-gauge"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

type Computed = {
  airflow_cfm: number | null
  airflow_confidence: string
  capacity_btuh: number | null
  total_watts: number | null
  live_eer: number | null
  measured_seer2_estimate: number | null
  coil_state: string
  tou_season: string
  tou_period: string
  rate_per_kwh: number
  cost_per_hour: number | null
  outdoor_temp_f: number | null
  weather_confidence: string | null
  efficiency_color: string
  system_running: boolean
  system_state: "cooling" | "off" | "fault"
  cooling_delta_f: number | null
  sensor_faults: { code: string; severity: "warn" | "fault"; message: string }[]
  diagnostics: {
    ratedSeer2: number | null
    anomalyNote: string
    coilStateNote: string
    airflowNote: string
    systemStateNote: string
  }
}

// Maps an efficiency_color verdict to a gauge/accent + plain-language copy.
const VERDICT: Record<
  string,
  { accent: "ok" | "warn" | "orange" | "bad" | "primary"; dot: string; title: string; sub: string }
> = {
  green: { accent: "ok", dot: "bg-ok glow-ok", title: "Running efficiently", sub: "Performance is at or above this system's healthy baseline." },
  yellow: { accent: "warn", dot: "bg-warn glow-warn", title: "Slightly below normal", sub: "A mild dip from the baseline for these outdoor conditions." },
  orange: { accent: "orange", dot: "bg-orange glow-orange", title: "Underperforming", sub: "Clearly below the healthy baseline. Worth a look." },
  red: { accent: "bad", dot: "bg-bad glow-bad", title: "Needs attention", sub: "Well below the healthy baseline for these conditions." },
  learning: { accent: "primary", dot: "bg-primary glow-primary", title: "Learning your system", sub: "Building a healthy baseline. Color verdicts begin once there's enough history." },
  idle: { accent: "primary", dot: "bg-muted", title: "System is off", sub: "No condenser power, blower power, or temperature drop detected — nothing to score right now." },
  unknown: { accent: "primary", dot: "bg-primary glow-primary", title: "Running — measuring", sub: "The system is actively cooling, but efficiency can't be scored yet (a supply-air reading is needed)." },
}

const PERIOD_LABEL: Record<string, string> = {
  on_peak: "On-Peak",
  off_peak: "Off-Peak",
  super_off_peak: "Super Off-Peak",
}

function money(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return `$${n.toFixed(digits)}`
}

export function PerformancePanel() {
  const { data, isLoading } = useSWR<{ ok: boolean; hasProfile: boolean; computed: Computed }>(
    "/api/compute/live",
    fetcher,
    { refreshInterval: 5000 },
  )
  const { data: cost } = useSWR<{ accumulated_cost: number; customer_charge: number; month: string }>(
    "/api/cost/summary",
    fetcher,
    { refreshInterval: 15000 },
  )

  // Drive persistence on a fixed cadence while the dashboard is open. The
  // server enforces the locked sample interval, so extra calls are no-ops.
  useEffect(() => {
    const tick = () => {
      fetch("/api/compute/persist", { method: "POST" }).catch(() => {})
    }
    tick()
    const id = setInterval(tick, 60000)
    return () => clearInterval(id)
  }, [])

  const c = data?.computed
  const faults = c?.sensor_faults ?? []
  const hasHardFault = faults.some((f) => f.severity === "fault")
  // A hard sensor fault takes visual priority over the efficiency color so a
  // contradiction (e.g. compressor on, blower reads 0 W) is never hidden.
  const verdict =
    c?.system_state === "fault" && hasHardFault
      ? { accent: "bad" as const, dot: "bg-bad glow-bad", title: "Sensor issue detected", sub: "The system appears to be cooling, but the sensors disagree. See the details below." }
      : VERDICT[c?.efficiency_color ?? "learning"] ?? VERDICT.learning

  const tons = c?.capacity_btuh != null ? c.capacity_btuh / 12000 : null
  const eer = c?.live_eer ?? null
  const seer2 = c?.measured_seer2_estimate ?? null
  const ratedSeer2 = c?.diagnostics?.ratedSeer2 ?? null

  return (
    <section aria-label="System performance" className="flex flex-col gap-4">
      {/* Efficiency color hero */}
      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-lg shadow-black/40">
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <span className={`h-4 w-4 shrink-0 rounded-full ${verdict.dot}`} aria-hidden />
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted">
                Efficiency Verdict
              </p>
              <h2 className="text-xl font-semibold text-foreground text-balance">{verdict.title}</h2>
              <p className="mt-1 max-w-md text-sm text-muted-foreground text-pretty">{verdict.sub}</p>
            </div>
          </div>
          <div className="flex items-center gap-6 sm:flex-col sm:items-end sm:gap-1">
            <div className="text-right">
              <p className="font-mono text-xs uppercase tracking-wider text-muted">Outdoor</p>
              <p className="text-lg font-semibold text-foreground">
                {c?.outdoor_temp_f != null ? `${Math.round(c.outdoor_temp_f)}°F` : "—"}
              </p>
            </div>
            <div className="text-right">
              <p className="font-mono text-xs uppercase tracking-wider text-muted">Coil</p>
              <p className="text-lg font-semibold capitalize text-foreground">{c?.coil_state ?? "—"}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Sensor-fault banner — shown only when signals disagree */}
      {faults.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label="Sensor alerts">
          {faults.map((f) => (
            <li
              key={f.code}
              className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${
                f.severity === "fault"
                  ? "border-bad/40 bg-bad/10 text-foreground"
                  : "border-warn/40 bg-warn/10 text-foreground"
              }`}
            >
              <span
                className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${
                  f.severity === "fault" ? "bg-bad glow-bad" : "bg-warn glow-warn"
                }`}
                aria-hidden
              />
              <span className="text-pretty">
                <span className="font-semibold capitalize">
                  {f.severity === "fault" ? "Sensor fault" : "Check"}:
                </span>{" "}
                {f.message}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Performance gauges */}
      <div className="rounded-2xl border border-border bg-card p-4 shadow-lg shadow-black/40">
        <h3 className="mb-3 text-sm font-semibold text-foreground">Live Performance</h3>
        {isLoading ? (
          <p className="py-10 text-center text-sm text-muted">Computing…</p>
        ) : (
          <div className="flex flex-wrap items-start justify-center gap-5">
            <RadialGauge
              value={eer ?? 0}
              min={0}
              max={16}
              label="Live EER"
              accent={verdict.accent === "primary" ? "primary" : verdict.accent}
            />
            <RadialGauge
              value={seer2 ?? 0}
              min={0}
              max={22}
              label={ratedSeer2 ? `Measured SEER2 (rated ${ratedSeer2})` : "Measured SEER2"}
              accent="accent"
            />
            <RadialGauge
              value={tons ?? 0}
              min={0}
              max={5}
              label="Capacity"
              unit="tons"
              accent="primary"
            />
            <RadialGauge
              value={c?.total_watts != null ? c.total_watts / 1000 : 0}
              min={0}
              max={6}
              label="Power Draw"
              unit="kW"
              accent="accent"
            />
          </div>
        )}
        {c && (eer == null || tons == null) ? (
          <p className="mt-3 rounded-lg border border-border bg-elevated px-3 py-2 text-center text-xs text-muted">
            {c.diagnostics?.airflowNote ?? "Waiting for the readings needed to compute efficiency."}
          </p>
        ) : null}
      </div>

      {/* Cost */}
      <div className="rounded-2xl border border-border bg-card p-4 shadow-lg shadow-black/40">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">Electricity Cost</h3>
          <span className="rounded-full border border-border bg-elevated px-2.5 py-1 font-mono text-xs text-muted-foreground">
            {PERIOD_LABEL[c?.tou_period ?? ""] ?? "—"} · {c?.tou_season ?? ""}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Right now" value={c?.cost_per_hour != null ? `${money(c.cost_per_hour)}/hr` : "—"} />
          <Stat label="Rate" value={`${money(c?.rate_per_kwh, 5)}/kWh`} />
          <Stat label="This month" value={money(cost?.accumulated_cost)} hint={cost ? `incl. ${money(cost.customer_charge)} base` : undefined} />
        </div>
        <p className="mt-3 text-center text-xs text-muted">
          Evergy Kansas Metro RTOU · tariff energy only (riders excluded)
        </p>
      </div>
    </section>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-elevated p-3 text-center">
      <p className="font-mono text-xs uppercase tracking-wider text-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">{value}</p>
      {hint ? <p className="mt-0.5 text-[10px] text-muted">{hint}</p> : null}
    </div>
  )
}
