"use client"

import useSWR from "swr"
import Link from "next/link"
import { Flame, Gauge, Repeat } from "lucide-react"
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

// ---- Shared types -----------------------------------------------------------

export type HeatingLive = {
  operating_mode: "heating" | "cooling" | "fan_only" | "off" | "unknown"
  furnace_stage: string
  fire_stage: string | null
  temp_rise_f: number | null
  delivered_btuh: number | null
  gas_input_btuh: number | null
  live_thermal_eff_pct: number | null
  rise_verdict: "low" | "ok" | "high" | "unknown" | null
  gas_cost_per_hour: number | null
  supply_temp_f: number | null
  return_temp_f: number | null
  diagnostics: { furnaceNote?: string; riseNote?: string | null; efficiencyNote?: string | null; efficiencyGrade?: string | null }
}

export type HeatingSummary = {
  ok: boolean
  today: {
    cycles: number
    burn_minutes: number
    avg_burn_minutes: number | null
    short_cycles: number
    ignitions: number
    failed_lights: number
    avg_rise_f: number | null
    gas_therms: number
    gas_cost: number | null
  }
  week: { gas_cost: number | null }
  month: { gas_cost: number | null }
  season: {
    since: string
    cycles: number
    measured_cycles: number
    delivered_pct: number | null
    enough: boolean
    min_cycles: number
    short_cycle_pct: number | null
    avg_rise_f: number | null
    avg_burn_minutes: number | null
  }
  rated: {
    afue_pct: number | null
    expected_band: { low: number; high: number } | null
    rise_min_f: number | null
    rise_max_f: number | null
    gas_rate_per_therm: number | null
  }
  setup: { gas_input: boolean; afue: boolean; rise_range: boolean; gas_rate: boolean; signature_commissioned: boolean }
  decoder: { last_run: string | null; last_sample_at: string | null; cycle_in_progress: boolean }
}

export function useHeatingSummary() {
  return useSWR<HeatingSummary>("/api/heating/summary", fetcher, { refreshInterval: 60000 })
}

const STAGE_LABEL: Record<string, string> = {
  idle: "Off",
  fan_only: "Fan only",
  prepurge: "Starting up — clearing the burner",
  ignition: "Lighting",
  burn: "Burning",
  post_purge: "Burner off — blower pulling the last heat out",
  cooling_blower: "Cooling blower (not heating)",
  unknown: "No furnace reading",
}

function Header({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-elevated">{icon}</span>
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
    </div>
  )
}

function Stat({ label, value, sub, tone = "text-foreground" }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-border bg-elevated p-3 text-center">
      <p className="font-mono text-[10px] uppercase tracking-wider text-muted">{label}</p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${tone}`}>{value}</p>
      {sub ? <p className="mt-0.5 text-[10px] text-muted">{sub}</p> : null}
    </div>
  )
}

function SetupNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-center text-xs text-warn text-pretty">
      {children}{" "}
      <Link href="/setup" className="underline underline-offset-2">
        Open Setup
      </Link>
    </p>
  )
}

// ---- Temperature rise ---------------------------------------------------------

export function TemperatureRiseCard({ live, summary }: { live: HeatingLive | undefined; summary: HeatingSummary | undefined }) {
  const heatingNow = live?.operating_mode === "heating"
  const rise = heatingNow ? live?.temp_rise_f ?? null : null
  const min = summary?.rated.rise_min_f ?? null
  const max = summary?.rated.rise_max_f ?? null
  const verdict = heatingNow ? live?.rise_verdict ?? "unknown" : null

  // Bar scale 0–90 °F with the nameplate range shaded.
  const scaleMax = 90
  const pct = (v: number) => `${Math.min(100, Math.max(0, (v / scaleMax) * 100))}%`

  const verdictCopy =
    verdict === "ok"
      ? { text: "Inside the range on the furnace sticker. Airflow is right for this furnace.", tone: "text-ok" }
      : verdict === "high"
        ? { text: "Above the sticker range — not enough air moving. Check the filter, blower speed and ducts.", tone: "text-bad" }
        : verdict === "low"
          ? { text: "Below the sticker range — too much air for this burner, or the burner is firing low.", tone: "text-warn" }
          : verdict === "unknown"
            ? { text: min == null ? "Enter the rise range from the furnace sticker to judge this." : "Waiting for steady burn to judge the rise.", tone: "text-muted" }
            : { text: "The furnace isn't heating right now. Today's average is shown when there is one.", tone: "text-muted" }

  const shown = rise ?? summary?.today.avg_rise_f ?? null

  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-lg shadow-black/40">
      <Header icon={<Gauge className="h-5 w-5 text-orange" />} title="Temperature rise" />
      <div className="text-center">
        <p className="text-4xl font-semibold tabular-nums text-foreground">
          {shown != null ? `${Math.round(shown)}°F` : "—"}
        </p>
        <p className="mt-1 text-xs text-muted">
          {rise != null ? "How much hotter the air leaves than it comes in, right now" : shown != null ? "Today's average rise" : "How much hotter the air leaves than it comes in"}
        </p>
      </div>

      <div className="relative mt-4 h-3 w-full rounded-full bg-elevated">
        {min != null && max != null ? (
          <div
            className="absolute top-0 h-3 rounded-full bg-ok/30"
            style={{ left: pct(min), width: `calc(${pct(max)} - ${pct(min)})` }}
            aria-hidden
          />
        ) : null}
        {shown != null ? (
          <div
            className="absolute -top-1 h-5 w-1.5 -translate-x-1/2 rounded-full bg-orange"
            style={{ left: pct(shown) }}
            aria-hidden
          />
        ) : null}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted">
        <span>0°</span>
        <span>{min != null && max != null ? `Sticker range ${min}–${max}°F` : "No sticker range entered"}</span>
        <span>{scaleMax}°</span>
      </div>

      <p className={`mt-3 text-center text-sm text-pretty ${verdictCopy.tone}`}>{verdictCopy.text}</p>
      {summary && !summary.setup.rise_range ? <SetupNote>Add the rise range from the furnace sticker.</SetupNote> : null}
    </div>
  )
}

// ---- Furnace cycles -------------------------------------------------------------

export function FurnaceCyclesCard({ live, summary }: { live: HeatingLive | undefined; summary: HeatingSummary | undefined }) {
  const t = summary?.today
  const stage = live?.furnace_stage ?? "unknown"
  const fire = live?.fire_stage
  const stageText =
    stage === "burn" && fire && fire !== "unknown" && fire !== "single" ? `Burning — ${fire} fire` : STAGE_LABEL[stage] ?? stage
  const active = ["prepurge", "ignition", "burn", "post_purge"].includes(stage)

  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-lg shadow-black/40">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-elevated">
            <Repeat className="h-5 w-5 text-orange" />
          </span>
          <h3 className="text-base font-semibold text-foreground">Furnace cycles today</h3>
        </div>
        {summary && !summary.setup.signature_commissioned ? (
          <span className="rounded-md border border-border bg-elevated px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
            Learning
          </span>
        ) : null}
      </div>

      <div className="mb-3 flex items-center justify-center gap-2 rounded-xl border border-border bg-elevated px-3 py-2">
        <span className={`inline-block h-2 w-2 rounded-full ${active ? "bg-orange" : "bg-muted"}`} aria-hidden />
        <p className="text-sm text-foreground">{stageText}</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Stat label="Cycles" value={t ? String(t.cycles) : "—"} sub="times it fired" />
        <Stat
          label="Avg run"
          value={t?.avg_burn_minutes != null ? `${t.avg_burn_minutes} min` : "—"}
          sub="burner on per cycle"
        />
        <Stat
          label="Short cycles"
          value={t ? String(t.short_cycles) : "—"}
          sub="ran under 5 min"
          tone={t && t.short_cycles > 0 ? "text-bad" : "text-foreground"}
        />
        <Stat
          label="Burner on"
          value={t ? `${t.burn_minutes} min` : "—"}
          sub="total today"
        />
      </div>
      {t && t.failed_lights > 0 ? (
        <p className="mt-3 rounded-xl border border-bad/30 bg-bad/10 px-3 py-2 text-center text-xs text-bad">
          {t.failed_lights} time{t.failed_lights === 1 ? "" : "s"} today the furnace tried to light and didn't. Worth a look at the igniter and flame sensor.
        </p>
      ) : null}
      <p className="mt-3 text-center text-[11px] text-muted">
        Short cycles are what wear a furnace out. A healthy cycle runs well past 5 minutes.
      </p>
    </div>
  )
}

// ---- Heating efficiency chart ---------------------------------------------------

type SegPoint = {
  day: string
  seg: number
  avgEff: number | null
  minEff: number | null
  maxEff: number | null
  avgRise: number | null
  minRise: number | null
  maxRise: number | null
  burnMinutes: number
  cycles: number
}
type SegResp = {
  ok: boolean
  view: "daily" | "weekly" | "monthly"
  afuePct: number | null
  expectedBand: { low: number; high: number } | null
  riseMinF: number | null
  riseMaxF: number | null
  points: SegPoint[]
  availableMonths: AvailableMonth[]
}

export function HeatingEfficiencyChart({ live, summary }: { live: HeatingLive | undefined; summary: HeatingSummary | undefined }) {
  const range = useChartRange()
  const { data } = useSWR<SegResp>(`/api/heating/segments?date=${range.anchorIso}&view=${range.view}`, fetcher, {
    refreshInterval: 60000,
  })

  const pts = data?.points ?? []
  const hasEff = pts.some((p) => p.avgEff != null)
  // Until the gas input is set, plot the temperature rise so there's still a
  // real measured history to look at.
  const points: BandPoint[] = pts.map((p) => ({
    day: p.day,
    seg: p.seg,
    avg: hasEff ? p.avgEff : p.avgRise,
    min: hasEff ? p.minEff : p.minRise,
    max: hasEff ? p.maxEff : p.maxRise,
  }))

  const months = data?.availableMonths ?? [{ year: range.selYear, month: range.selMonth }]
  const afue = summary?.rated.afue_pct ?? data?.afuePct ?? null
  const liveEff = live?.operating_mode === "heating" ? live?.live_thermal_eff_pct ?? null : null
  const season = summary?.season

  const refLines = hasEff
    ? [
        ...(afue != null ? [{ value: afue, label: `Rated ${afue}%`, color: "var(--color-muted)" }] : []),
        ...(data?.expectedBand
          ? [{ value: data.expectedBand.low, label: "Expected", color: "var(--color-ok)", dashed: true }]
          : []),
      ]
    : [
        ...(data?.riseMinF != null ? [{ value: data.riseMinF, label: `Min ${data.riseMinF}°`, color: "var(--color-muted)", dashed: true }] : []),
        ...(data?.riseMaxF != null ? [{ value: data.riseMaxF, label: `Max ${data.riseMaxF}°`, color: "var(--color-muted)", dashed: true }] : []),
      ]

  const title =
    range.view === "daily"
      ? `${MONTH_NAMES[range.selMonth - 1]} ${range.safeDay}, ${range.selYear} — by hour`
      : range.view === "weekly"
        ? `${MONTH_NAMES[range.selMonth - 1]} ${range.selYear} — this week, by time of day`
        : `${MONTH_NAMES[range.selMonth - 1]} ${range.selYear} — full month`

  return (
    <ChartCard
      icon={<Flame className="h-5 w-5 text-orange" />}
      title="Furnace efficiency"
      subtitle={afue != null ? `Rated ${afue}% AFUE${liveEff != null ? ` · running ${Math.round(liveEff)}%` : ""}` : "Measured from the air side, cycle by cycle"}
      badge={
        liveEff != null ? (
          <div className="rounded-xl border border-orange/30 bg-orange/10 px-3 py-1.5 text-right">
            <p className="text-[10px] uppercase tracking-wide text-muted">Right now</p>
            <p className="text-sm font-bold tabular-nums text-orange">{Math.round(liveEff)}%</p>
          </div>
        ) : null
      }
    >
      <div className="rounded-xl border border-orange/40 bg-elevated p-4">
        <ChartControls range={range} availableMonths={months} toggleLabel="Furnace efficiency" />
        <h4 className="mb-2 text-center text-sm font-semibold text-foreground text-pretty">
          {hasEff ? title : `${title} — temperature rise`}
        </h4>
        {!data ? (
          <p className="rounded-lg border border-border bg-card px-4 py-8 text-center text-sm text-muted">Loading…</p>
        ) : points.every((p) => p.avg == null) ? (
          <p className="rounded-lg border border-border bg-card px-4 py-8 text-center text-sm text-muted">
            No furnace cycles recorded in this window.
          </p>
        ) : (
          <BandLineChart
            points={points}
            view={range.view}
            unit={hasEff ? "%" : "°"}
            digits={0}
            bandColor="var(--color-orange)"
            lineColor="var(--color-orange)"
            refLines={refLines}
            onDrillDay={range.drillDown}
            ariaLabel={hasEff ? "Furnace efficiency per cycle against the rated AFUE" : "Furnace temperature rise per cycle"}
          />
        )}
      </div>

      <div
        className={`mt-3 rounded-xl border border-border bg-elevated p-3 text-center ${season?.enough ? "" : "opacity-60"}`}
      >
        <p className="text-[10px] uppercase tracking-wide text-muted">This heating season, all cycles together</p>
        <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
          {season?.delivered_pct != null ? `${Math.round(season.delivered_pct)}%` : "—"}
          {afue != null ? <span className="text-sm font-normal text-muted"> vs {afue}% rated</span> : null}
        </p>
        <p className="mt-0.5 text-[11px] text-muted">
          {season
            ? season.enough
              ? `${season.measured_cycles} measured cycles since ${season.since}`
              : `${season.measured_cycles} of ${season.min_cycles} cycles measured — needs more before it means much`
            : "—"}
        </p>
        {season && season.cycles > 0 ? (
          <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
            <div>
              <p className="text-muted">Short cycles</p>
              <p className={`tabular-nums ${season.short_cycle_pct ? "text-bad" : "text-foreground"}`}>
                {season.short_cycle_pct != null ? `${season.short_cycle_pct}%` : "—"}
              </p>
            </div>
            <div>
              <p className="text-muted">Avg rise</p>
              <p className="tabular-nums text-foreground">
                {season.avg_rise_f != null ? `${season.avg_rise_f}°F` : "—"}
                {summary?.rated.rise_min_f != null && summary?.rated.rise_max_f != null ? (
                  <span className="text-muted"> ({summary.rated.rise_min_f}–{summary.rated.rise_max_f})</span>
                ) : null}
              </p>
            </div>
            <div>
              <p className="text-muted">Avg run</p>
              <p className="tabular-nums text-foreground">
                {season.avg_burn_minutes != null ? `${season.avg_burn_minutes} min` : "—"}
              </p>
            </div>
          </div>
        ) : null}
      </div>

      {summary && (!summary.setup.gas_input || !summary.setup.afue) ? (
        <SetupNote>
          Efficiency needs the gas meter clocked{summary.setup.afue ? "" : " and the AFUE from the sticker"}. Until then this chart shows temperature rise.
        </SetupNote>
      ) : null}
    </ChartCard>
  )
}
