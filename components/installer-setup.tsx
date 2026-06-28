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

// Master enrollment toggle with a switch control + helper text.
function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3 sm:col-span-2">
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="text-xs leading-relaxed text-muted">{hint}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full border transition-colors ${
          checked ? "border-primary bg-primary" : "border-border bg-elevated"
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-background transition-transform ${
            checked ? "translate-x-5" : "translate-x-0.5"
          }`}
        />
      </button>
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
  "condenser_serial",
  "evaporator_coil_model",
  "metering_type",
  "rated_seer2",
  "seer2_conversion_factor",
  "equipment_class",
  "blower_type",
  "blower_model",
  "blower_speed_tap",
  "ecm_profile",
  "cfm_per_ton",
  "weather_zip",
  // Automation tuning (revealed when a toggle is on).
  "auto_comfort_temp_min_f",
  "auto_comfort_temp_max_f",
  "peak_dodger_precool_offset_f",
  "peak_dodger_coast_offset_f",
] as const

// Automation enrollment toggles (booleans, default OFF).
const TOGGLE_KEYS = [
  "auto_comfort_enabled",
  "auto_comfort_fan_enabled",
  "peak_dodger_enabled",
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
  const [toggles, setToggles] = useState<Record<string, boolean>>({})
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
    const t: Record<string, boolean> = {}
    for (const k of TOGGLE_KEYS) t[k] = Boolean(p[k])
    setToggles(t)
  }

  function toggle(name: string, value: boolean) {
    setTouched(true)
    setToggles((t) => ({ ...t, [name]: value }))
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
        body: JSON.stringify({ ...form, ...toggles, evergy_rtou_confirmed: rtou }),
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
            label="Condenser serial number"
            hint="The serial number on the outdoor unit's rating plate. Used for service records."
            name="condenser_serial"
            placeholder="e.g. 1234A5678"
            value={v("condenser_serial")}
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
          <Field
            label="Airflow per ton (CFM/ton)"
            hint="Design airflow for this blower. 400 is the common rule of thumb; 350 is typical for high-humidity setups. Used as the airflow baseline."
            name="cfm_per_ton"
            type="number"
            unit="CFM/ton"
            placeholder="e.g. 400"
            value={v("cfm_per_ton")}
            onChange={set}
          />
        </Section>

        <Section
          title="Location"
          blurb="Just the ZIP code for this home. The app finds the nearest official weather station and pulls live outdoor conditions and air pressure on its own."
        >
          <Field
            label="Home ZIP code"
            hint="Used to find the nearest official weather station automatically."
            name="weather_zip"
            placeholder="e.g. 67202"
            value={v("weather_zip")}
            onChange={set}
          />
        </Section>

        <Section
          title="Rated Efficiency"
          blurb="The manufacturer's lab ratings. The app uses these as a reference and a sanity check, then shows your real measured performance against them."
        >
          <Field
            label="Rated SEER2 (nameplate)"
            hint="The SEER2 number from the manufacturer's spec sheet or AHRI certificate. This is the lab rating, not the live measured value."
            name="rated_seer2"
            type="number"
            unit="SEER2"
            placeholder="e.g. 15.2"
            value={v("rated_seer2")}
            onChange={set}
          />
          <Select
            label="Equipment class"
            hint="The type of system. This sets how the live measurement is converted to a SEER2-equivalent estimate."
            name="equipment_class"
            value={v("equipment_class")}
            onChange={set}
            options={[
              { value: "standard_split", label: "Standard split system" },
              { value: "two_stage_split", label: "Two-stage split system" },
              { value: "variable_speed_inverter", label: "Variable-speed / inverter" },
              { value: "packaged_unit", label: "Packaged unit" },
              { value: "heat_pump", label: "Heat pump (cooling mode)" },
            ]}
          />
          <Field
            label="SEER2 conversion factor (optional)"
            hint="Leave blank to use the default for the equipment class. Enter a number to fine-tune how live EER becomes the Measured SEER2 Estimate."
            name="seer2_conversion_factor"
            type="number"
            placeholder="e.g. 0.95"
            value={v("seer2_conversion_factor")}
            onChange={set}
          />
        </Section>

        <Section
          title="Automation"
          blurb="Let Elevate act on the thermostat to keep the home comfortable and dodge peak-hour costs. These run automatically in the background around the clock — even when the app is closed. Everything is OFF by default — turn on only what this home is enrolled in. When connected, Elevate adjusts automatically; without a thermostat connection these become recommendations only."
        >
          <Toggle
            label="Automatic Comfort Adjustment"
            hint="When the home drifts out of comfort, Elevate nudges the thermostat back toward the learned target — never outside the safety band below."
            checked={Boolean(toggles.auto_comfort_enabled)}
            onChange={(v) => toggle("auto_comfort_enabled", v)}
          />
          {toggles.auto_comfort_enabled ? (
            <>
              <Field
                label="Lowest allowed temperature"
                hint="Automation will never cool below this, for any reason."
                name="auto_comfort_temp_min_f"
                type="number"
                unit="°F"
                placeholder="68"
                value={v("auto_comfort_temp_min_f")}
                onChange={set}
              />
              <Field
                label="Highest allowed temperature"
                hint="Automation will never let the home rise above this, for any reason."
                name="auto_comfort_temp_max_f"
                type="number"
                unit="°F"
                placeholder="78"
                value={v("auto_comfort_temp_max_f")}
                onChange={set}
              />
              <Toggle
                label="Allow fan circulation"
                hint="Let Elevate run the thermostat fan for short bursts to improve comfort through circulation (energy-efficient)."
                checked={Boolean(toggles.auto_comfort_fan_enabled)}
                onChange={(v) => toggle("auto_comfort_fan_enabled", v)}
              />
            </>
          ) : null}

          <Toggle
            label="Peak Dodger"
            hint="Pre-cools before Evergy peak hours (4–8 PM) so the system coasts through the expensive window. Skips weekends and holidays automatically."
            checked={Boolean(toggles.peak_dodger_enabled)}
            onChange={(v) => toggle("peak_dodger_enabled", v)}
          />
          {toggles.peak_dodger_enabled ? (
            <>
              <Field
                label="Pre-cool amount"
                hint="How many degrees to pre-cool before peak, banking coolness in the home's thermal mass."
                name="peak_dodger_precool_offset_f"
                type="number"
                unit="°F"
                placeholder="3"
                value={v("peak_dodger_precool_offset_f")}
                onChange={set}
              />
              <Field
                label="Coast amount"
                hint="How many degrees to ease off during peak so the compressor barely runs (still clamped to the band above)."
                name="peak_dodger_coast_offset_f"
                type="number"
                unit="°F"
                placeholder="3"
                value={v("peak_dodger_coast_offset_f")}
                onChange={set}
              />
            </>
          ) : null}
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
