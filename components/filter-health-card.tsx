"use client"

import { useState } from "react"
import useSWR from "swr"
import { Filter, Flag, RotateCcw, Check, Loader2, AlertTriangle, X } from "lucide-react"
import {
  computeFilterHealth,
  ratioToArcFraction,
  validateCapture,
  type FilterBand,
} from "@/lib/filter/health"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

type FilterEvent = {
  id: string
  occurred_at: string
  floor_static_inwc: number
  fresh_static_inwc: number
  filter_drop_fresh_inwc: number
  note: string | null
}
type FilterResponse = {
  ok: boolean
  latest: FilterEvent | null
  events: FilterEvent[]
  days_since_change: number | null
}

const BAND_HEX: Record<FilterBand, string> = {
  green: "#29d17e",
  yellow: "#f5b13d",
  red: "#ef4757",
  black: "#06080b",
}

// ---- Gauge geometry --------------------------------------------------------
const W = 230
const H = 142
const CX = W / 2
const CY = 122
const R = 96

function polar(angleDeg: number, radius = R) {
  const a = (angleDeg * Math.PI) / 180
  return { x: CX + radius * Math.cos(a), y: CY - radius * Math.sin(a) }
}
// Fraction 0..1 along the arc → angle (180deg on the left to 0deg on the right).
function fracToAngle(frac: number) {
  return 180 * (1 - frac)
}
function arc(fracStart: number, fracEnd: number, radius = R) {
  const s = polar(fracToAngle(fracStart), radius)
  const e = polar(fracToAngle(fracEnd), radius)
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${radius} ${radius} 0 0 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`
}

// Band boundaries expressed as arc fractions (R 1→3 maps to 0→1).
const SEG = [
  { band: "green" as const, from: ratioToArcFraction(1.0), to: ratioToArcFraction(1.5) },
  { band: "yellow" as const, from: ratioToArcFraction(1.5), to: ratioToArcFraction(2.0) },
  { band: "red" as const, from: ratioToArcFraction(2.0), to: ratioToArcFraction(2.25) },
  { band: "black" as const, from: ratioToArcFraction(2.25), to: ratioToArcFraction(3.0) },
]

function NeedleGauge({
  ratio,
  calibrated,
  band,
}: {
  ratio: number | null
  calibrated: boolean
  band: FilterBand | null
}) {
  const frac = ratio == null ? 0 : ratioToArcFraction(ratio)
  const needleAngle = fracToAngle(frac)
  const tip = polar(needleAngle, R - 14)
  const needleColor = band ? BAND_HEX[band] : "#3a4453"

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Filter load gauge">
      {/* Uncalibrated: a single dim track, no colors. */}
      {!calibrated ? (
        <path d={arc(0, 1)} fill="none" stroke="#1d2531" strokeWidth={12} strokeLinecap="round" />
      ) : (
        SEG.map((s) => (
          <path
            key={s.band}
            d={arc(s.from, s.to)}
            fill="none"
            stroke={BAND_HEX[s.band]}
            strokeWidth={12}
            strokeLinecap="butt"
            opacity={band === s.band ? 1 : 0.4}
          />
        ))
      )}

      {/* Divider ticks + labels at load multipliers 1, 2, 3. */}
      {[1, 2, 3].map((mult) => {
        const f = ratioToArcFraction(mult)
        const inner = polar(fracToAngle(f), R - 18)
        const outer = polar(fracToAngle(f), R + 2)
        const lbl = polar(fracToAngle(f), R + 16)
        return (
          <g key={mult}>
            <line
              x1={inner.x}
              y1={inner.y}
              x2={outer.x}
              y2={outer.y}
              stroke="#5b6573"
              strokeWidth={2}
            />
            <text
              x={lbl.x}
              y={lbl.y + 4}
              textAnchor="middle"
              className="fill-muted-foreground"
              style={{ fontSize: 12, fontWeight: 600 }}
            >
              {mult}
            </text>
          </g>
        )
      })}

      {/* Needle (only when we have a real verdict). */}
      {calibrated && ratio != null ? (
        <>
          <line
            x1={CX}
            y1={CY}
            x2={tip.x}
            y2={tip.y}
            stroke={needleColor}
            strokeWidth={3.5}
            strokeLinecap="round"
            style={{ transition: "all 0.6s ease" }}
          />
          <circle cx={CX} cy={CY} r={6} fill={needleColor} />
        </>
      ) : (
        <circle cx={CX} cy={CY} r={5} fill="#3a4453" />
      )}
    </svg>
  )
}

// ===========================================================================
// Reusable two-step calibration workflow (used on the card + in installer).
// ===========================================================================
export function FilterCalibrationWorkflow({
  onComplete,
  onCancel,
}: {
  onComplete?: () => void
  onCancel?: () => void
}) {
  const [step, setStep] = useState<0 | 1 | 2>(0)
  const [floor, setFloor] = useState<number | null>(null)
  const [fresh, setFresh] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function readLiveStatic(): Promise<number | null> {
    try {
      const res = await fetch("/api/compute/live").then((r) => r.json())
      const v = res?.computed?.static_pressure_inwc
      return typeof v === "number" && Number.isFinite(v) ? v : null
    } catch {
      return null
    }
  }

  async function capture(which: "floor" | "fresh") {
    setBusy(true)
    setError(null)
    const v = await readLiveStatic()
    setBusy(false)
    if (v == null) {
      setError("No live static pressure reading available right now. Check the sensor and try again.")
      return
    }
    if (which === "floor") {
      setFloor(v)
      setStep(2)
    } else {
      setFresh(v)
    }
  }

  async function submit() {
    if (floor == null || fresh == null) return
    const valid = validateCapture(floor, fresh)
    if (!valid.ok) {
      setError(valid.error)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/filter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ floor_static_inwc: floor, fresh_static_inwc: fresh }),
      }).then((r) => r.json())
      if (!res.ok) {
        setError(res.error ?? "Could not save the calibration.")
        setBusy(false)
        return
      }
      onComplete?.()
    } catch {
      setError("Could not save the calibration. Please try again.")
      setBusy(false)
    }
  }

  function reset() {
    setStep(0)
    setFloor(null)
    setFresh(null)
    setError(null)
  }

  const fmt = (v: number | null) => (v == null ? "—" : `${v.toFixed(2)}" WC`)

  return (
    <div className="rounded-xl border border-border bg-elevated p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-foreground">Filter calibration</p>
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close calibration"
            className="rounded-lg p-1 text-muted-foreground transition hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {/* Progress dots */}
      <div className="mb-4 flex items-center gap-2" aria-hidden>
        {[0, 1, 2].map((s) => (
          <span
            key={s}
            className={`h-1.5 flex-1 rounded-full ${
              (step === 0 ? 0 : step) >= s ? "bg-primary" : "bg-border"
            }`}
          />
        ))}
      </div>

      {step === 0 ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground text-pretty">
            We&apos;ll capture two quick readings to learn this system&apos;s baseline. This isolates the
            filter&apos;s own restriction, so it works on any ductwork.
          </p>
          <button
            type="button"
            onClick={() => setStep(1)}
            className="rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90"
          >
            Start calibration
          </button>
        </div>
      ) : null}

      {step === 1 ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium text-foreground">Step 1 — Remove the filter</p>
          <p className="text-sm text-muted-foreground text-pretty">
            Take the filter out completely, let the system run for a moment, then capture the no-filter
            reading.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => capture("floor")}
            className="flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Capture no-filter reading
          </button>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-sm text-ok">
            <Check className="h-4 w-4" /> No-filter baseline: {fmt(floor)}
          </div>
          <p className="text-sm font-medium text-foreground">Step 2 — Install a fresh filter</p>
          <p className="text-sm text-muted-foreground text-pretty">
            Put a clean filter in, let it run a moment, then capture the fresh-filter reading.
          </p>
          {fresh == null ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => capture("fresh")}
              className="flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Capture fresh-filter reading
            </button>
          ) : (
            <>
              <div className="flex items-center gap-2 text-sm text-ok">
                <Check className="h-4 w-4" /> Fresh-filter reading: {fmt(fresh)}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={submit}
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  Save calibration
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={reset}
                  className="flex items-center justify-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5 text-sm font-medium text-muted-foreground transition hover:text-foreground"
                >
                  <RotateCcw className="h-4 w-4" /> Redo
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {error ? (
        <p className="mt-3 flex items-start gap-2 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  )
}

// ===========================================================================
// The Home View card — needle gauge + live static + calibration entry point.
// ===========================================================================
export function FilterHealthCard({ staticInWc }: { staticInWc: number | null }) {
  const { data, mutate } = useSWR<FilterResponse>("/api/filter", fetcher, { refreshInterval: 30000 })
  const [calibrating, setCalibrating] = useState(false)

  const baseline = data?.latest
    ? {
        floor_static_inwc: data.latest.floor_static_inwc,
        filter_drop_fresh_inwc: data.latest.filter_drop_fresh_inwc,
      }
    : null
  const health = computeFilterHealth(staticInWc, baseline)
  const days = data?.days_since_change ?? null

  const toneClass =
    health.band === "green"
      ? "text-ok"
      : health.band === "yellow"
        ? "text-warn"
        : health.band === "red"
          ? "text-bad"
          : health.band === "black"
            ? "text-bad"
            : "text-muted-foreground"

  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-lg shadow-black/40">
      <div className="mb-2 flex items-center gap-3">
        <Filter className="h-5 w-5 text-accent" />
        <h3 className="text-base font-semibold text-foreground">Filter health</h3>
      </div>

      <div className="relative flex flex-col items-center">
        {/* Pulsing red flag overlay for the severe (black) state. */}
        {health.severe ? (
          <div className="pointer-events-none absolute right-1 top-1 z-10 flex items-center gap-1.5 rounded-full border border-bad/50 bg-bad/15 px-2.5 py-1 filter-flag-pulse">
            <Flag className="h-3.5 w-3.5 text-bad" />
            <span className="text-[11px] font-semibold text-bad">Replace</span>
          </div>
        ) : null}

        <NeedleGauge ratio={health.ratio} calibrated={health.calibrated} band={health.band} />

        {/* The real measured static — what a tech expects to see. */}
        <div className="-mt-6 flex flex-col items-center">
          <span className="font-mono text-3xl font-bold tabular-nums tracking-tight text-foreground">
            {staticInWc != null ? `${staticInWc.toFixed(2)}"` : "—"}
          </span>
          <span className="text-xs font-medium uppercase tracking-wide text-muted">WC static</span>
        </div>
      </div>

      {/* Verdict line. */}
      <div className="mt-3 rounded-xl border border-border bg-elevated p-4 text-center">
        <p className={`text-base font-semibold text-pretty ${toneClass}`}>{health.label}</p>
        <p className="mt-0.5 text-xs text-muted-foreground text-pretty">{health.detail}</p>
        {health.calibrated && days != null ? (
          <p className="mt-2 text-xs text-muted">
            Days since last filter change: <span className="font-semibold text-foreground">{days}</span>
          </p>
        ) : null}
      </div>

      {/* Calibration workflow / entry button. */}
      {calibrating ? (
        <div className="mt-3">
          <FilterCalibrationWorkflow
            onCancel={() => setCalibrating(false)}
            onComplete={() => {
              setCalibrating(false)
              mutate()
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setCalibrating(true)}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-elevated px-4 py-2.5 text-sm font-medium text-muted-foreground transition hover:text-foreground"
        >
          <RotateCcw className="h-4 w-4" />
          {health.calibrated ? "Calibrate / Change filter" : "Calibrate for filter health"}
        </button>
      )}
    </div>
  )
}
