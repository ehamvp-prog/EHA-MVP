"use client"

import { useEffect, useState } from "react"
import useSWR from "swr"
import Link from "next/link"
import { DeviceCard } from "./device-card"
import { WeatherPanel } from "./weather-panel"
import { HistoryFeed } from "./history-feed"
import { PerformancePanel } from "./performance-panel"
import { HomeView } from "./home-view"
import { freshness } from "@/lib/telemetry-format"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

type DeviceRow = {
  id: number
  device_id: string
  device_type: string | null
  received_at: string
  payload: Record<string, unknown>
}

export function Dashboard() {
  const { data, isLoading, error } = useSWR("/api/telemetry/latest?history=50", fetcher, {
    refreshInterval: 5000,
  })

  // View toggle: "tech" (existing) vs "home" (homeowner-friendly). Persists
  // for the session. Starts on "tech" to match SSR, then restores on mount.
  const [view, setView] = useState<"tech" | "home">("tech")
  useEffect(() => {
    const saved = sessionStorage.getItem("eha-view")
    if (saved === "home" || saved === "tech") setView(saved)
  }, [])
  const selectView = (v: "tech" | "home") => {
    setView(v)
    sessionStorage.setItem("eha-view", v)
  }

  const devices: DeviceRow[] = data?.devices ?? []
  const history: DeviceRow[] = data?.history ?? []

  // Overall system status = freshest device.
  const anyLive = devices.some((d) => freshness(d.received_at) === "live")
  const systemState = anyLive ? "live" : devices.length > 0 ? "stale" : "dead"
  const dotClass =
    systemState === "live"
      ? "bg-ok glow-ok"
      : systemState === "stale"
        ? "bg-warn glow-warn"
        : "bg-bad glow-bad"

  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl px-4 py-6">
      {/* Header */}
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">Elevate Home App</p>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground text-balance">
            System Dashboard
          </h1>
        </div>
        <div className="flex items-center gap-4">
          {/* View toggle: Home vs Tech. Instant, no reload. */}
          <div
            className="flex items-center rounded-full border border-border bg-card p-0.5"
            role="tablist"
            aria-label="Dashboard view"
          >
            <button
              type="button"
              role="tab"
              aria-selected={view === "home"}
              onClick={() => selectView("home")}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                view === "home" ? "bg-primary text-primary-foreground" : "text-muted hover:text-foreground"
              }`}
            >
              Home
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "tech"}
              onClick={() => selectView("tech")}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                view === "tech" ? "bg-primary text-primary-foreground" : "text-muted hover:text-foreground"
              }`}
            >
              Tech
            </button>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5">
            <span className={`h-2.5 w-2.5 rounded-full ${dotClass}`} aria-hidden />
            <span className="text-xs font-medium text-muted-foreground">
              {systemState === "live"
                ? "Receiving data"
                : systemState === "stale"
                  ? "Data is slow"
                  : "Waiting for sensors"}
            </span>
          </div>
          <Link
            href="/setup"
            className="text-xs font-medium text-muted hover:text-foreground"
          >
            Setup
          </Link>
          <Link
            href="/status"
            className="text-xs font-medium text-muted hover:text-foreground"
          >
            System check
          </Link>
        </div>
      </header>

      {view === "home" ? (
        <HomeView />
      ) : (
        <>
      {/* Performance — the live efficiency engine output */}
      <div className="mb-6">
        <PerformancePanel />
      </div>

      {/* Weather */}
      <div className="mb-6">
        <WeatherPanel />
      </div>

      {/* Devices */}
      <div className="mb-6">
        <h2 className="mb-3 text-sm font-semibold text-foreground">
          Sensors{" "}
          <span className="ml-1 font-normal text-muted">({devices.length})</span>
        </h2>

        {isLoading ? (
          <p className="rounded-2xl border border-border bg-card py-10 text-center text-sm text-muted">
            Connecting to sensors…
          </p>
        ) : error ? (
          <p className="rounded-2xl border border-border bg-card py-10 text-center text-sm text-bad">
            Could not load telemetry.
          </p>
        ) : devices.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-card px-4 py-10 text-center">
            <p className="text-sm font-medium text-foreground">No sensor data yet</p>
            <p className="mx-auto mt-1 max-w-md text-xs text-muted">
              Once a Shelly or DHT22 device posts to the ingest endpoint, it shows up here
              automatically. Bring sensors online one at a time to confirm their field names.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {devices.map((d) => (
              <DeviceCard key={d.device_id} device={d} />
            ))}
          </div>
        )}
      </div>

      {/* History */}
      <HistoryFeed rows={history} />
        </>
      )}

      <p className="mt-6 text-center text-xs text-muted">
        Elevate Home App · live efficiency, cost &amp; health · updates every 5 seconds
      </p>
    </main>
  )
}
