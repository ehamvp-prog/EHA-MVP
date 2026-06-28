"use client"

import { useState } from "react"
import useSWR from "swr"
import { Thermometer, Snowflake, Flame, RefreshCw, Power, Fan, Minus, Plus, Wifi } from "lucide-react"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

type Thermostat = {
  ambientTempF: number | null
  humidity: number | null
  mode: "HEAT" | "COOL" | "HEATCOOL" | "OFF" | null
  hvacStatus: "HEATING" | "COOLING" | "OFF" | null
  heatSetpointF: number | null
  coolSetpointF: number | null
  fanMode: "ON" | "OFF" | null
}

type NestData = {
  ok: boolean
  configured: boolean
  connected: boolean
  needsReconnect?: boolean
  thermostat: Thermostat | null
}

// Nest data is rate-limited and only changes occasionally — poll every 5 min.
const POLL_MS = 5 * 60 * 1000

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

// Plain-English HVAC status.
function statusLine(t: Thermostat): { label: string; tone: string } {
  if (t.mode === "OFF") return { label: "System is off", tone: "text-muted-foreground" }
  if (t.hvacStatus === "COOLING") return { label: "Currently cooling", tone: "text-accent" }
  if (t.hvacStatus === "HEATING") return { label: "Currently heating", tone: "text-orange" }
  return { label: "System is idle", tone: "text-muted-foreground" }
}

function activeSetpoint(t: Thermostat): { value: number | null; verb: string } {
  if (t.mode === "COOL") return { value: t.coolSetpointF, verb: "Set to" }
  if (t.mode === "HEAT") return { value: t.heatSetpointF, verb: "Set to" }
  if (t.mode === "HEATCOOL") return { value: null, verb: "Auto range" }
  return { value: null, verb: "" }
}

export function NestCard() {
  const { data, mutate, isLoading } = useSWR<NestData>("/api/nest/data", fetcher, {
    refreshInterval: POLL_MS,
    revalidateOnFocus: false,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Hide the card entirely until the env vars are configured.
  if (data && !data.configured) return null
  if (isLoading && !data) {
    return (
      <div className="rounded-2xl border border-border bg-card p-5 shadow-lg shadow-black/40">
        <SectionHeader icon={<Thermometer className="h-5 w-5 text-primary" />} title="Your thermostat" />
        <p className="text-sm text-muted-foreground">Checking your Nest connection…</p>
      </div>
    )
  }

  // Not connected, or token died → connect / reconnect.
  if (data && (!data.connected || data.needsReconnect)) {
    const reconnect = data.needsReconnect
    return (
      <div className="rounded-2xl border border-border bg-card p-5 shadow-lg shadow-black/40">
        <SectionHeader icon={<Thermometer className="h-5 w-5 text-primary" />} title="Your thermostat" />
        <p className="mb-4 text-sm text-muted-foreground text-pretty">
          {reconnect
            ? "Your Nest connection expired. Reconnect to keep seeing and controlling your thermostat here."
            : "Connect your Google Nest thermostat to see its temperature and control it right from this app."}
        </p>
        <a
          href={reconnect ? "/api/nest/auth?reconnect=1" : "/api/nest/auth"}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
        >
          {reconnect ? <RefreshCw className="h-4 w-4" /> : <Wifi className="h-4 w-4" />}
          {reconnect ? "Reconnect Nest" : "Connect Nest"}
        </a>
      </div>
    )
  }

  const t = data?.thermostat
  if (!t) {
    return (
      <div className="rounded-2xl border border-border bg-card p-5 shadow-lg shadow-black/40">
        <SectionHeader icon={<Thermometer className="h-5 w-5 text-primary" />} title="Your thermostat" />
        <p className="text-sm text-muted-foreground">No Nest thermostat found on your account.</p>
      </div>
    )
  }

  const status = statusLine(t)
  const setpoint = activeSetpoint(t)

  async function control(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/nest/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        if (json.error === "rate_limited") setError("Nest is busy — try again in a moment.")
        else if (json.error === "needs_reconnect") {
          await mutate()
        } else setError("Couldn't update the thermostat. Please try again.")
        return
      }
      // Reflect the returned state immediately.
      mutate({ ...(data as NestData), thermostat: json.thermostat }, { revalidate: false })
    } catch {
      setError("Couldn't reach your thermostat. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  // Adjust the setpoint for the active single-mode (HEAT or COOL).
  function adjustSetpoint(delta: number) {
    if (t!.mode === "COOL" && t!.coolSetpointF != null) {
      control({ coolSetpoint: t!.coolSetpointF + delta })
    } else if (t!.mode === "HEAT" && t!.heatSetpointF != null) {
      control({ heatSetpoint: t!.heatSetpointF + delta })
    }
  }

  const canAdjust = t.mode === "COOL" || t.mode === "HEAT"
  const modes: { key: Thermostat["mode"]; label: string; icon: React.ReactNode }[] = [
    { key: "COOL", label: "Cool", icon: <Snowflake className="h-4 w-4" /> },
    { key: "HEAT", label: "Heat", icon: <Flame className="h-4 w-4" /> },
    { key: "HEATCOOL", label: "Auto", icon: <Thermometer className="h-4 w-4" /> },
    { key: "OFF", label: "Off", icon: <Power className="h-4 w-4" /> },
  ]

  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-lg shadow-black/40">
      <SectionHeader icon={<Thermometer className="h-5 w-5 text-primary" />} title="Your thermostat" />

      {/* Current readings */}
      <div className="mb-4 grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-border bg-elevated p-4 text-center">
          <p className="text-xs uppercase tracking-wide text-muted">Indoor temp</p>
          <p className="mt-1 text-3xl font-semibold text-foreground tabular-nums">
            {t.ambientTempF != null ? `${t.ambientTempF}°F` : "—"}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-elevated p-4 text-center">
          <p className="text-xs uppercase tracking-wide text-muted">Humidity</p>
          <p className="mt-1 text-3xl font-semibold text-foreground tabular-nums">
            {t.humidity != null ? `${t.humidity}%` : "—"}
          </p>
        </div>
      </div>

      {/* Status + active setpoint */}
      <div className="mb-4 flex items-center justify-between rounded-xl border border-border bg-elevated px-4 py-3">
        <span className={`text-sm font-medium ${status.tone}`}>{status.label}</span>
        {setpoint.value != null ? (
          <span className="text-sm font-semibold text-foreground">
            {setpoint.verb} {setpoint.value}°F
          </span>
        ) : t.mode === "HEATCOOL" ? (
          <span className="text-sm font-semibold text-foreground">
            {t.heatSetpointF ?? "—"}° – {t.coolSetpointF ?? "—"}°F
          </span>
        ) : null}
      </div>

      {/* Setpoint adjust (single-mode only) */}
      {canAdjust ? (
        <div className="mb-4 flex items-center justify-center gap-6">
          <button
            type="button"
            onClick={() => adjustSetpoint(-1)}
            disabled={busy}
            aria-label="Lower setpoint"
            className="flex h-11 w-11 items-center justify-center rounded-full border border-border bg-elevated text-foreground transition-colors hover:bg-card disabled:opacity-50"
          >
            <Minus className="h-5 w-5" />
          </button>
          <span className="min-w-20 text-center text-4xl font-semibold text-foreground tabular-nums">
            {setpoint.value != null ? `${setpoint.value}°` : "—"}
          </span>
          <button
            type="button"
            onClick={() => adjustSetpoint(1)}
            disabled={busy}
            aria-label="Raise setpoint"
            className="flex h-11 w-11 items-center justify-center rounded-full border border-border bg-elevated text-foreground transition-colors hover:bg-card disabled:opacity-50"
          >
            <Plus className="h-5 w-5" />
          </button>
        </div>
      ) : null}

      {/* Mode selector */}
      <div className="mb-3">
        <p className="mb-2 text-xs uppercase tracking-wide text-muted">Mode</p>
        <div className="grid grid-cols-4 gap-2">
          {modes.map((m) => {
            const active = t.mode === m.key
            return (
              <button
                key={m.key}
                type="button"
                onClick={() => control({ mode: m.key })}
                disabled={busy || active}
                className={`flex flex-col items-center gap-1 rounded-xl border px-2 py-2.5 text-xs font-medium transition-colors ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-elevated text-muted hover:text-foreground disabled:opacity-50"
                }`}
              >
                {m.icon}
                {m.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Fan toggle */}
      <div>
        <p className="mb-2 text-xs uppercase tracking-wide text-muted">Fan</p>
        <div className="grid grid-cols-2 gap-2">
          {(["AUTO", "ON"] as const).map((fm) => {
            const active = (t.fanMode === "ON" ? "ON" : "AUTO") === fm
            return (
              <button
                key={fm}
                type="button"
                onClick={() => control({ fanMode: fm })}
                disabled={busy || active}
                className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${
                  active
                    ? "border-accent bg-accent text-accent-foreground"
                    : "border-border bg-elevated text-muted hover:text-foreground disabled:opacity-50"
                }`}
              >
                <Fan className="h-4 w-4" />
                {fm === "AUTO" ? "Auto" : "On"}
              </button>
            )
          })}
        </div>
      </div>

      {error ? <p className="mt-3 text-sm text-bad">{error}</p> : null}
    </div>
  )
}
