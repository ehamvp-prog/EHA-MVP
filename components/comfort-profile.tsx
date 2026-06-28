"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR, { mutate } from "swr"
import { Thermometer, Droplets, Users, Activity, HeartPulse, Smile, ThumbsUp, Sparkles } from "lucide-react"
import {
  computeHappyNumber,
  happyBand,
  recommendations,
  type ActivityLevel,
  type AgeGroup,
  type ComfortProfile as Profile,
} from "@/lib/comfort/happy-number"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

type ProfileRow = Profile & {
  anchor_set_at: string | null
}

const DEFAULT_PROFILE: ProfileRow = {
  preferred_temp_f: 72,
  preferred_rh: 45,
  age_group: "mixed",
  activity_level: "moderate",
  household_size: 2,
  health_considerations: [],
  anchor_set_at: null,
}

const AGE_OPTIONS: { value: AgeGroup; label: string }[] = [
  { value: "young_adults", label: "Young Adults (18-35)" },
  { value: "adults", label: "Adults (36-55)" },
  { value: "seniors", label: "Seniors (55+)" },
  { value: "mixed", label: "Mixed Household" },
]

const ACTIVITY_OPTIONS: { value: ActivityLevel; label: string; sub: string }[] = [
  { value: "sedentary", label: "Sedentary", sub: "Home office, relaxed lifestyle" },
  { value: "moderate", label: "Moderate", sub: "Regular movement, some activity" },
  { value: "active", label: "Active", sub: "Kids, pets, high activity" },
]

const HEALTH_OPTIONS: { value: string; label: string }[] = [
  { value: "asthma", label: "Asthma" },
  { value: "allergies", label: "Allergies" },
  { value: "copd", label: "COPD" },
  { value: "arthritis", label: "Arthritis" },
  { value: "migraines", label: "Migraines" },
  { value: "skin_sensitivity", label: "Skin Sensitivity" },
  { value: "sleep_issues", label: "Sleep Issues" },
]

export function ComfortProfilePanel({
  liveTempF,
  liveRh,
  systemRunning,
}: {
  liveTempF: number | null
  liveRh: number | null
  systemRunning: boolean
}) {
  const { data, isLoading } = useSWR<{ ok: boolean; profile: ProfileRow | null }>(
    "/api/comfort/profile",
    fetcher,
  )

  const [form, setForm] = useState<ProfileRow>(DEFAULT_PROFILE)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [hasProfile, setHasProfile] = useState<boolean | null>(null)

  // Hydrate the form once the saved profile loads.
  useEffect(() => {
    if (data && !dirty) {
      if (data.profile) {
        setForm({ ...DEFAULT_PROFILE, ...data.profile, health_considerations: data.profile.health_considerations ?? [] })
        setHasProfile(true)
      } else {
        setHasProfile(false)
      }
    }
  }, [data, dirty])

  const set = <K extends keyof ProfileRow>(key: K, value: ProfileRow[K]) => {
    setForm((f) => ({ ...f, [key]: value }))
    setDirty(true)
  }

  const toggleHealth = (v: string) => {
    setForm((f) => {
      const has = f.health_considerations.includes(v)
      return { ...f, health_considerations: has ? f.health_considerations.filter((x) => x !== v) : [...f.health_considerations, v] }
    })
    setDirty(true)
  }

  async function save() {
    setSaving(true)
    try {
      await fetch("/api/comfort/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      })
      await mutate("/api/comfort/profile")
      setDirty(false)
      setHasProfile(true)
      setSavedAt(Date.now())
      setTimeout(() => setSavedAt(null), 2500)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section aria-label="Comfort profile" className="flex flex-col gap-4">
      {/* Temperature & Humidity */}
      <Card>
        <CardHeader
          icon={<Thermometer className="h-5 w-5 text-primary" />}
          title="Temperature & Humidity"
          sub="What indoor conditions feel perfect to your family?"
        />
        <SliderRow
          icon={<Thermometer className="h-4 w-4 text-muted" />}
          label="Preferred Temperature"
          value={`${Math.round(form.preferred_temp_f)}°F`}
          min={65}
          max={80}
          step={1}
          val={form.preferred_temp_f}
          onChange={(v) => set("preferred_temp_f", v)}
          ticks={["65°F (Cool)", "72°F (Median)", "80°F (Warm)"]}
        />
        <SliderRow
          icon={<Droplets className="h-4 w-4 text-muted" />}
          label="Preferred Humidity"
          value={`${Math.round(form.preferred_rh)}%`}
          min={25}
          max={65}
          step={1}
          val={form.preferred_rh}
          onChange={(v) => set("preferred_rh", v)}
          ticks={["25% (Dry)", "45% (Median)", "65% (Humid)"]}
        />
      </Card>

      {/* Household Demographics */}
      <Card>
        <CardHeader
          icon={<Users className="h-5 w-5 text-primary" />}
          title="Household Demographics"
          sub="Help us understand who lives in your home"
        />
        <FieldLabel icon={<Users className="h-4 w-4 text-muted" />}>Primary Age Group</FieldLabel>
        <div className="grid grid-cols-2 gap-2">
          {AGE_OPTIONS.map((o) => (
            <PillButton key={o.value} active={form.age_group === o.value} onClick={() => set("age_group", o.value)}>
              {o.label}
            </PillButton>
          ))}
        </div>

        <FieldLabel icon={<Activity className="h-4 w-4 text-muted" />} className="mt-5">
          Activity Level
        </FieldLabel>
        <div className="flex flex-col gap-2">
          {ACTIVITY_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => set("activity_level", o.value)}
              className={`flex items-baseline gap-2 rounded-xl border px-4 py-3 text-left transition-colors ${
                form.activity_level === o.value
                  ? "border-primary bg-primary/10"
                  : "border-border bg-elevated hover:border-muted"
              }`}
            >
              <span className="font-semibold text-foreground">{o.label}</span>
              <span className="text-xs text-muted">{o.sub}</span>
            </button>
          ))}
        </div>

        <FieldLabel icon={<Users className="h-4 w-4 text-muted" />} className="mt-5">
          Household Size
        </FieldLabel>
        <div className="flex gap-2">
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => set("household_size", n)}
              className={`flex h-11 flex-1 items-center justify-center rounded-full border text-sm font-semibold transition-colors ${
                form.household_size === n
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border bg-elevated text-muted hover:text-foreground"
              }`}
            >
              {n === 6 ? "6+" : n}
            </button>
          ))}
        </div>
      </Card>

      {/* Health Considerations */}
      <Card>
        <CardHeader
          icon={<HeartPulse className="h-5 w-5 text-primary" />}
          title="Health Considerations"
          sub="Select any conditions that affect your comfort needs (optional)"
        />
        <div className="grid grid-cols-2 gap-2">
          {HEALTH_OPTIONS.map((o) => (
            <PillButton
              key={o.value}
              active={form.health_considerations.includes(o.value)}
              onClick={() => toggleHealth(o.value)}
            >
              {o.label}
            </PillButton>
          ))}
          <PillButton
            active={form.health_considerations.length === 0}
            onClick={() => {
              setForm((f) => ({ ...f, health_considerations: [] }))
              setDirty(true)
            }}
          >
            None
          </PillButton>
        </div>
      </Card>

      {/* Save */}
      <Card>
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="font-semibold text-foreground">Save your comfort profile</p>
            <p className="text-sm text-muted-foreground text-pretty">
              Your dashboard uses this to tailor your Happy Number and recommendations.
            </p>
          </div>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="shrink-0 rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground transition-opacity disabled:opacity-60"
          >
            {saving ? "Saving…" : savedAt ? "Saved ✓" : "Save Changes"}
          </button>
        </div>
      </Card>

      {/* Happy Number + recommendations + training */}
      <HappyNumberCard
        profile={form}
        hasProfile={hasProfile}
        isLoading={isLoading}
        liveTempF={liveTempF}
        liveRh={liveRh}
        systemRunning={systemRunning}
      />
    </section>
  )
}

// ---- Happy Number ----------------------------------------------------------

function HappyNumberCard({
  profile,
  hasProfile,
  isLoading,
  liveTempF,
  liveRh,
  systemRunning,
}: {
  profile: Profile
  hasProfile: boolean | null
  isLoading: boolean
  liveTempF: number | null
  liveRh: number | null
  systemRunning: boolean
}) {
  const monthCst = useMemo(() => new Date(Date.now() - 6 * 60 * 60 * 1000).getUTCMonth(), [])

  const result = useMemo(() => {
    if (liveTempF == null || liveRh == null) return null
    return computeHappyNumber({ liveTempF, liveRh, profile, monthCst })
  }, [liveTempF, liveRh, profile, monthCst])

  const recs = useMemo(() => {
    if (liveRh == null) return []
    return recommendations({ liveRh, profile })
  }, [liveRh, profile])

  if (isLoading) {
    return (
      <Card>
        <CardHeader icon={<Smile className="h-5 w-5 text-ok" />} title="Your Happy Number" />
        <p className="text-sm text-muted">Loading your comfort profile…</p>
      </Card>
    )
  }

  if (hasProfile === false) {
    return (
      <Card>
        <CardHeader icon={<Smile className="h-5 w-5 text-ok" />} title="Your Happy Number" />
        <p className="text-sm text-muted-foreground text-pretty">
          Set your comfort profile above and save it to see your live Happy Number.
        </p>
      </Card>
    )
  }

  if (!result) {
    return (
      <Card>
        <CardHeader icon={<Smile className="h-5 w-5 text-ok" />} title="Your Happy Number" />
        <p className="text-sm text-muted-foreground">
          Waiting for a live indoor reading to score your comfort…
        </p>
      </Card>
    )
  }

  const band = happyBand(result.happy)

  return (
    <Card>
      <CardHeader
        icon={<Smile className="h-5 w-5 text-ok" />}
        title="Your Happy Number"
        sub="A live comfort score based on ASHRAE Standard 55 and your household profile."
      />

      {!systemRunning ? (
        <p className="mb-3 rounded-lg border border-border bg-elevated px-3 py-2 text-xs text-warn">
          Last known — system is resting. Scored on the most recent indoor air.
        </p>
      ) : null}

      <div className="flex flex-col items-center">
        <HappyGauge value={result.happy} color={band.color} />
        <p className={`mt-3 text-center text-sm font-medium text-pretty ${band.color === "ok" ? "text-ok" : "text-warn"}`}>
          {band.label}
        </p>
      </div>

      {/* Ideal targets */}
      <div className="mt-4 grid grid-cols-2 gap-3">
        <MiniStat label="Ideal Temp" value={`${Math.round(profile.preferred_temp_f)}°F`} />
        <MiniStat label="Ideal Humidity" value={`${Math.round(profile.preferred_rh)}%`} />
      </div>

      {/* Recommendations */}
      {recs.length > 0 ? (
        <div className="mt-5">
          <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
            <Sparkles className="h-4 w-4 text-primary" /> Personalized Recommendations
          </h4>
          <ul className="flex flex-col gap-2">
            {recs.map((r) => (
              <li key={r} className="flex items-start gap-2 text-sm text-muted-foreground text-pretty">
                <ThumbsUp className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Training Mode */}
      <TrainingMode liveTempF={liveTempF} liveRh={liveRh} />

      <p className="mt-4 text-center text-[11px] text-muted">
        An estimate — clothing and activity are inferred from your profile, not directly sensed.
      </p>
    </Card>
  )
}

function TrainingMode({ liveTempF, liveRh }: { liveTempF: number | null; liveRh: number | null }) {
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)
  const ready = liveTempF != null && liveRh != null

  async function anchor() {
    if (!ready) return
    setSaving(true)
    try {
      await fetch("/api/comfort/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anchor_temp_f: liveTempF, anchor_rh: liveRh }),
      })
      await mutate("/api/comfort/profile")
      setDone(true)
      setTimeout(() => setDone(false), 3000)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-5 rounded-xl border border-ok/30 bg-ok/5 p-4">
      <h4 className="flex items-center gap-2 text-sm font-semibold text-ok">
        <ThumbsUp className="h-4 w-4" /> Training Mode
      </h4>
      <p className="mt-1 text-sm text-muted-foreground text-pretty">
        When your home feels exactly right, record the current temperature and humidity to anchor your
        comfort profile.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <MiniStat label="Current Temp" value={liveTempF != null ? `${Math.round(liveTempF)}°F` : "—"} />
        <MiniStat label="Current Humidity" value={liveRh != null ? `${Math.round(liveRh)}%` : "—"} />
      </div>
      <button
        type="button"
        onClick={anchor}
        disabled={!ready || saving}
        className="mt-3 w-full rounded-xl bg-ok px-4 py-3 text-sm font-semibold text-background transition-opacity disabled:opacity-50"
      >
        {saving ? "Saving…" : done ? "Anchored to right now ✓" : "My Home Feels Perfect Right Now"}
      </button>
    </div>
  )
}

// Radial gauge ring for the Happy Number (0-100).
function HappyGauge({ value, color }: { value: number; color: "ok" | "warn" | "bad" }) {
  const r = 70
  const c = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(100, value)) / 100
  const stroke = color === "ok" ? "var(--color-ok)" : color === "warn" ? "var(--color-warn)" : "var(--color-bad)"
  return (
    <div className="relative" style={{ width: 180, height: 180 }}>
      <svg viewBox="0 0 180 180" className="h-full w-full -rotate-90">
        <circle cx="90" cy="90" r={r} fill="none" stroke="var(--color-elevated)" strokeWidth="12" />
        <circle
          cx="90"
          cy="90"
          r={r}
          fill="none"
          stroke={stroke}
          strokeWidth="12"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
          style={{ transition: "stroke-dashoffset 0.6s ease" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-5xl font-bold tabular-nums text-foreground">{value}</span>
        <span className="text-xs text-muted">out of 100</span>
      </div>
    </div>
  )
}

// ---- Small presentational helpers -----------------------------------------

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-border bg-card p-5 shadow-lg shadow-black/40">{children}</div>
}

function CardHeader({ icon, title, sub }: { icon: React.ReactNode; title: string; sub?: string }) {
  return (
    <div className="mb-4">
      <div className="flex items-center gap-2.5">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-elevated">
          {icon}
        </span>
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
      </div>
      {sub ? <p className="mt-2 text-sm text-muted-foreground text-pretty">{sub}</p> : null}
    </div>
  )
}

function FieldLabel({
  children,
  icon,
  className = "",
}: {
  children: React.ReactNode
  icon?: React.ReactNode
  className?: string
}) {
  return (
    <p className={`mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted ${className}`}>
      {icon}
      {children}
    </p>
  )
}

function PillButton({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl border px-4 py-3 text-sm font-medium transition-colors ${
        active ? "border-primary bg-primary/10 text-foreground" : "border-border bg-elevated text-muted hover:text-foreground"
      }`}
    >
      {children}
    </button>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-elevated p-3 text-center">
      <p className="text-[10px] uppercase tracking-wider text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-foreground">{value}</p>
    </div>
  )
}

function SliderRow({
  icon,
  label,
  value,
  min,
  max,
  step,
  val,
  onChange,
  ticks,
}: {
  icon: React.ReactNode
  label: string
  value: string
  min: number
  max: number
  step: number
  val: number
  onChange: (v: number) => void
  ticks: [string, string, string] | string[]
}) {
  return (
    <div className="mb-5 last:mb-0">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          {icon}
          {label}
        </span>
        <span className="text-lg font-bold tabular-nums text-foreground">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={val}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-2 w-full cursor-pointer appearance-none rounded-full bg-elevated accent-primary"
        aria-label={label}
      />
      <div className="mt-1.5 flex justify-between text-[10px] text-muted">
        {ticks.map((t) => (
          <span key={t}>{t}</span>
        ))}
      </div>
    </div>
  )
}
