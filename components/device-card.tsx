"use client"

import { RadialGauge } from "./radial-gauge"
import { extractFields, timeAgo, freshness } from "@/lib/telemetry-format"

type DeviceRow = {
  id: number
  device_id: string
  device_type: string | null
  received_at: string
  payload: Record<string, unknown>
}

const DOT: Record<string, string> = {
  live: "bg-ok glow-ok",
  stale: "bg-warn glow-warn",
  dead: "bg-bad glow-bad",
}

const STATUS_TEXT: Record<string, string> = {
  live: "Live",
  stale: "Slow",
  dead: "No signal",
}

// Rotate gauge accent colors so a multi-field card stays readable.
const ACCENTS = ["primary", "accent"] as const

export function DeviceCard({ device }: { device: DeviceRow }) {
  const fields = extractFields(device.payload)
  const state = freshness(device.received_at)

  return (
    <section className="rounded-2xl border border-border bg-card p-4 shadow-lg shadow-black/40">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-mono text-sm font-semibold text-foreground">
            {device.device_id}
          </h3>
          <p className="text-xs text-muted">{device.device_type ?? "unknown type"}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${DOT[state]}`} aria-hidden />
          <span className="text-xs text-muted-foreground">{STATUS_TEXT[state]}</span>
        </div>
      </header>

      {fields.length > 0 ? (
        <div className="flex flex-wrap justify-center gap-4">
          {fields.map((f, i) => (
            <RadialGauge
              key={f.key}
              value={f.value}
              min={f.min}
              max={f.max}
              label={f.label}
              unit={f.unit}
              accent={ACCENTS[i % ACCENTS.length]}
            />
          ))}
        </div>
      ) : (
        <p className="py-6 text-center text-sm text-muted">
          No numeric readings in the last payload.
        </p>
      )}

      <footer className="mt-3 flex items-center justify-between border-t border-border pt-2 text-xs text-muted">
        <span>Last reading {timeAgo(device.received_at)}</span>
        <span className="font-mono">{fields.length} field(s)</span>
      </footer>
    </section>
  )
}
