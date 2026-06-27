"use client"

import { useState } from "react"
import useSWR from "swr"
import Link from "next/link"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

type Profile = Record<string, string | number | boolean | null>

// Small labeled text/number input with helper text.
function Field({
  label,
  hint,
  name,
  value,
  onChange,
  type = "text",
  placeholder,
  unit,
}: {
  label: string
  hint?: string
  name: string
  value: string
  onChange: (name: string, value: string) => void
  type?: string
  placeholder?: string
  unit?: string
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-foreground">{label}</span>
      {hint ? <span className="text-xs leading-relaxed text-muted">{hint}</span> : null}
      <div className="flex items-center gap-2">
        <input
          type={type}
          name={name}
          value={value}
          inputMode={type === "number" ? "decimal" : undefined}
          placeholder={placeholder}
          onChange={(e) => onChange(name, e.target.value)}
          className="w-full rounded-xl border border-border bg-input px-3 py-2.5 text-sm text-foreground outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
        />
        {unit ? <span className="shrink-0 text-xs text-muted">{unit}</span> : null}
      </div>
    </label>
  )
}

// Labeled dropdown.
function Select({
  label,
  hint,
  name,
  value,
  onChange,
  options,
}: {
  label: string
  hint?: string
  name: string
  value: string
  onChange: (name: string, value: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-foreground">{label}</span>
      {hint ? <span className="text-xs leading-relaxed text-muted">{hint}</span> : null}
      <select
        name={name}
        value={value}
        onChange={(e) => onChange(name, e.target.value)}
        className="w-full rounded-xl border border-border bg-input px-3 py-2.5 text-sm text-foreground outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
      >
        <option value="">Choose one…</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function Section({ title, blurb, children }: { title: string; blurb: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-panel">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted">{blurb}</p>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div>
    </section>
  )
}

const FIELD_KEYS = [
  "system_tonnage",
  "condenser_make",
  "condenser_model",
  "evaporator_coil_model",
  "metering_type",
  "blower_type",
  "blower_model",
  "blower_speed_tap",
  "ecm_profile",
  "coil_state",
  "barometric_pressure_inhg",
  "weather_zip",
  "weather_station_id",
] as const

export function InstallerSetup() {
  const { data, mutate } = useSWR<{ ok: boolean; profile: Profile | null }>("/api/profile", fetcher, {
    revalidateOnFocus: false,
    onSuccess: (d) => {
      if (d?.profile && !touched) hydrate(d.profile)
    },
  })

  const [form, setForm] = useState<Record<string, string>>({})
  const [rtou, setRtou] = useState(false)
  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: "ok" | "bad"; text: string } | null>(null)

  function hydrate(p: Profile) {
    const next: Record<string, string> = {}
    for (const k of FIELD_KEYS) {
      const v = p[k]
      next[k] = v === null || v === undefined ? "" : String(v)
    }
    setForm(next)
    setRtou(Boolean(p.evergy_rtou_confirmed))
  }

  function set(name: string, value: string) {
    setTouched(true)
    setForm((f) => ({ ...f, [name]: value }))
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setMessage(null)
    try {
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, evergy_rtou_confirmed: rtou }),
      })
      const json = await res.json()
      if (!json.ok) {
        setMessage({ kind: "bad", text: json.error ?? "Something went wrong." })
      } else {
        setMessage({ kind: "ok", text: "Saved. Your system profile is up to date." })
        setTouched(false)
        mutate()
      }
    } catch {
      setMessage({ kind: "bad", text: "Could not save. Check your connection and try again." })
    } finally {
      setSaving(false)
    }
  }

  const v = (k: string) => form[k] ?? ""

  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl px-4 py-6">
      <header className="mb-6">
        <Link href="/" className="text-xs font-medium text-muted hover:text-foreground">
          ← Back to dashboard
        </Link>
        <p className="mt-2 font-mono text-xs uppercase tracking-[0.2em] text-primary">Elevate Home App</p>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground text-balance">Installer Setup</h1>
        <p className="mt-1 max-w-xl text-sm leading-relaxed text-muted">
          Fill this out once for this home. These details tell the app what equipment it is measuring, so the
          efficiency math matches your real system instead of generic guesses. You can change it anytime.
        </p>
      </header>

      <form onSubmit={save} className="flex flex-col gap-5">
        <Section
          title="The System"
          blurb="The basics of the air conditioner and indoor coil you are measuring."
        >
          <Field
            label="System size (tonnage)"
            hint="How many tons the system is rated for. A '3 ton' unit means 3."
            name="system_tonnage"
            type="number"
            unit="tons"
            placeholder="e.g. 3"
            value={v("system_tonnage")}
            onChange={set}
          />
          <Field
            label="Condenser make"
            hint="The brand on the outdoor unit (e.g. Trane, Carrier, Goodman)."
            name="condenser_make"
            placeholder="e.g. Trane"
            value={v("condenser_make")}
            onChange={set}
          />
          <Field
            label="Condenser model"
            hint="The model number on the outdoor unit's rating plate."
            name="condenser_model"
            placeholder="e.g. 4TTR6036"
            value={v("condenser_model")}
            onChange={set}
          />
          <Field
            label="Evaporator coil model"
            hint="The matched indoor coil model number."
            name="evaporator_coil_model"
            placeholder="e.g. 4PXCBU037BC3"
            value={v("evaporator_coil_model")}
            onChange={set}
          />
          <Select
            label="Metering type"
            hint="How refrigerant is metered into the coil."
            name="metering_type"
            value={v("metering_type")}
            onChange={set}
            options={[
              { value: "piston_fixed_orifice", label: "Piston / fixed orifice" },
              { value: "txv", label: "TXV (thermostatic expansion valve)" },
            ]}
          />
        </Section>

        <Section
          title="The Blower"
          blurb="The fan that moves air through the system. This affects how airflow is calculated."
        >
          <Select
            label="Blower location"
            hint="Is the blower in a furnace or a standalone air handler?"
            name="blower_type"
            value={v("blower_type")}
            onChange={set}
            options={[
              { value: "furnace", label: "Furnace" },
              { value: "air_handler", label: "Air handler" },
            ]}
          />
          <Field
            label="Blower / furnace model"
            hint="The model number of the furnace or air handler."
            name="blower_model"
            placeholder="e.g. S9V2B080U3"
            value={v("blower_model")}
            onChange={set}
          />
          <Field
            label="Speed tap"
            hint="If it's a multi-speed blower, which tap the cooling speed is wired to."
            name="blower_speed_tap"
            placeholder="e.g. high, tap 4"
            value={v("blower_speed_tap")}
            onChange={set}
          />
          <Field
            label="ECM profile"
            hint="If it's a variable-speed (ECM) motor, the airflow profile or CFM setting."
            name="ecm_profile"
            placeholder="e.g. 350 CFM/ton"
            value={v("ecm_profile")}
            onChange={set}
          />
          <Select
            label="Coil state"
            hint="Wet coil means the system is actively cooling and pulling humidity. Dry coil means it isn't."
            name="coil_state"
            value={v("coil_state")}
            onChange={set}
            options={[
              { value: "wet", label: "Wet (cooling, removing humidity)" },
              { value: "dry", label: "Dry (not removing humidity)" },
            ]}
          />
        </Section>

        <Section
          title="Location & Weather"
          blurb="Where this home is, so we can pull the right outdoor conditions and air pressure."
        >
          <Field
            label="Barometric pressure anchor"
            hint="Local air pressure in inches of mercury (inHg). Used when live pressure isn't available. Sea level is about 29.92."
            name="barometric_pressure_inhg"
            type="number"
            unit="inHg"
            placeholder="e.g. 29.92"
            value={v("barometric_pressure_inhg")}
            onChange={set}
          />
          <Field
            label="Home ZIP code"
            hint="Used to find the nearest official weather station."
            name="weather_zip"
            placeholder="e.g. 67202"
            value={v("weather_zip")}
            onChange={set}
          />
          <Field
            label="Weather station ID (optional)"
            hint="If you know a specific nearby station, enter its ID. Otherwise the nearest one is used."
            name="weather_station_id"
            placeholder="e.g. KICT"
            value={v("weather_station_id")}
            onChange={set}
          />
        </Section>

        <Section title="Utility Rate" blurb="Confirms which Evergy rate plan this home is on for cost calculations.">
          <label className="flex items-start gap-3 sm:col-span-2">
            <input
              type="checkbox"
              checked={rtou}
              onChange={(e) => {
                setTouched(true)
                setRtou(e.target.checked)
              }}
              className="mt-0.5 h-5 w-5 shrink-0 rounded border-border bg-input accent-primary"
            />
            <span className="text-sm leading-relaxed text-foreground">
              This home is on the Evergy Kansas Metro{" "}
              <span className="font-medium text-primary">Schedule RTOU</span> (Residential Time-of-Use) rate.
            </span>
          </label>
        </Section>

        {message ? (
          <p
            className={`rounded-xl border px-4 py-3 text-sm ${
              message.kind === "ok"
                ? "border-ok/40 bg-ok/10 text-ok"
                : "border-bad/40 bg-bad/10 text-bad"
            }`}
            role="status"
          >
            {message.text}
          </p>
        ) : null}

        <div className="sticky bottom-4 flex items-center justify-end gap-3">
          <button
            type="submit"
            disabled={saving}
            className="rounded-xl bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground shadow-glow transition hover:brightness-110 disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save system profile"}
          </button>
        </div>
      </form>
    </main>
  )
}
