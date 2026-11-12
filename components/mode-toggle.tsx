"use client"

import { useEffect, useState } from "react"

// =====================================================================
// Heat | Cool tile toggle.
//
// THIS IS A VIEW, NOT A CONTROL. It only decides which set of tiles the
// Home screen draws. It never talks to the thermostat, never calls
// /api/nest/control, never writes season_mode, and never changes which
// automation runs. The Nest card has the real Heat / Cool / Auto buttons.
//
// Default = what the system detects (season_mode). Tapping the other side
// shows the other tiles; the note keeps saying what's actually detected.
// The choice is remembered on this device and cleared automatically when
// the detected season changes, so a tap in October doesn't stick into June.
// =====================================================================

export type TileMode = "heating" | "cooling"

const KEY = "eha.tileMode"

type Stored = { mode: TileMode; detected: TileMode }

function readStored(): Stored | null {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Stored
    if ((v.mode === "heating" || v.mode === "cooling") && (v.detected === "heating" || v.detected === "cooling")) return v
    return null
  } catch {
    return null
  }
}

function writeStored(v: Stored | null) {
  try {
    if (v) window.localStorage.setItem(KEY, JSON.stringify(v))
    else window.localStorage.removeItem(KEY)
  } catch {
    /* private window etc. — the toggle still works for this visit */
  }
}

// Returns the tile set to show plus a setter for the toggle.
export function useTileMode(detected: TileMode | null): [TileMode, (m: TileMode) => void] {
  const [override, setOverride] = useState<Stored | null>(null)

  useEffect(() => {
    setOverride(readStored())
  }, [])

  // Detected season changed since the override was set → drop the override.
  useEffect(() => {
    if (!detected || !override) return
    if (override.detected !== detected) {
      setOverride(null)
      writeStored(null)
    }
  }, [detected, override])

  const shown: TileMode = override && detected && override.detected === detected ? override.mode : (detected ?? "cooling")

  const set = (m: TileMode) => {
    if (!detected) return
    if (m === detected) {
      setOverride(null)
      writeStored(null)
    } else {
      const v = { mode: m, detected }
      setOverride(v)
      writeStored(v)
    }
  }
  return [shown, set]
}

export function ModeToggle({
  detected,
  shown,
  onChange,
}: {
  detected: TileMode | null
  shown: TileMode
  onChange: (m: TileMode) => void
}) {
  const seg = (m: TileMode, label: string) => {
    const active = shown === m
    return (
      <button
        type="button"
        role="radio"
        aria-checked={active}
        onClick={() => onChange(m)}
        disabled={!detected}
        className={`rounded-md px-3 py-1 text-xs font-semibold transition-colors ${
          active
            ? m === "heating"
              ? "bg-orange text-background"
              : "bg-accent text-accent-foreground"
            : "text-muted hover:text-foreground"
        }`}
      >
        {label}
      </button>
    )
  }

  return (
    <div className="flex items-center justify-center gap-3">
      <div
        className="flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5"
        role="radiogroup"
        aria-label="Which tiles to show"
      >
        {seg("heating", "Heat")}
        {seg("cooling", "Cool")}
      </div>
      <p className="text-xs text-muted">
        {detected ? `System auto detects ${detected}` : "Detecting system mode…"}
      </p>
    </div>
  )
}
