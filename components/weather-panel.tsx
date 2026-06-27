"use client"

import { useState } from "react"
import useSWR, { mutate } from "swr"
import { RadialGauge } from "./radial-gauge"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

const CONF_STYLE: Record<string, string> = {
  high: "bg-ok/15 text-ok border-ok/30",
  medium: "bg-warn/15 text-warn border-warn/30",
  low: "bg-bad/15 text-bad border-bad/30",
}

export function WeatherPanel() {
  const { data, isLoading } = useSWR("/api/weather", fetcher, { refreshInterval: 60000 })
  const [zip, setZip] = useState("")
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const weather = data?.weather
  const needsLocation = data?.needs_location

  async function saveZip(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setMsg(null)
    try {
      const res = await fetch("/api/weather/location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zip }),
      })
      const json = await res.json()
      if (!json.ok) {
        setMsg(json.error ?? "Could not save location.")
      } else {
        setMsg(`Set to ${json.location.city}, ${json.location.state}.`)
        setZip("")
        mutate("/api/weather")
      }
    } catch {
      setMsg("Something went wrong saving the location.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="rounded-2xl border border-border bg-card p-4 shadow-lg shadow-black/40">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Outdoor Weather</h2>
        {weather?.weather_confidence ? (
          <span
            className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
              CONF_STYLE[weather.weather_confidence] ?? ""
            }`}
          >
            {weather.weather_confidence} confidence
          </span>
        ) : null}
      </header>

      {/* Location setter */}
      <form onSubmit={saveZip} className="mb-4 flex flex-wrap items-center gap-2">
        <label htmlFor="zip" className="sr-only">
          Home ZIP code
        </label>
        <input
          id="zip"
          inputMode="numeric"
          placeholder="Enter home ZIP code"
          value={zip}
          onChange={(e) => setZip(e.target.value.replace(/\D/g, "").slice(0, 5))}
          className="w-40 rounded-lg border border-border bg-elevated px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-primary"
        />
        <button
          type="submit"
          disabled={saving || zip.length !== 5}
          className="rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground transition-opacity disabled:opacity-40"
        >
          {saving ? "Saving…" : "Set location"}
        </button>
      </form>
      {msg ? <p className="mb-3 text-xs text-muted-foreground">{msg}</p> : null}

      {isLoading ? (
        <p className="py-6 text-center text-sm text-muted">Loading weather…</p>
      ) : needsLocation ? (
        <p className="py-6 text-center text-sm text-muted">
          Add a ZIP code above to start pulling outdoor readings from the National Weather Service.
        </p>
      ) : weather?.ok ? (
        <>
          <div className="flex flex-wrap justify-center gap-4">
            <RadialGauge
              value={weather.outdoor_temp_f ?? 0}
              min={0}
              max={120}
              label="Outdoor Temp"
              unit="°F"
              accent="accent"
            />
            <RadialGauge
              value={weather.outdoor_rh ?? 0}
              min={0}
              max={100}
              label="Outdoor Humidity"
              unit="%"
              accent="primary"
            />
            <RadialGauge
              value={weather.outdoor_pressure_inhg ?? 0}
              min={28}
              max={31}
              label="Pressure"
              unit="inHg"
              accent="accent"
            />
          </div>
          <footer className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-xs text-muted">
            <span>
              Source {weather.weather_source} · Station{" "}
              <span className="font-mono">{weather.weather_station_id}</span>
            </span>
            <span>Observed {weather.weather_obs_age_min ?? "—"} min ago</span>
          </footer>
        </>
      ) : (
        <p className="py-6 text-center text-sm text-bad">
          {data?.error ?? weather?.error ?? "Weather unavailable right now."}
        </p>
      )}
    </section>
  )
}
