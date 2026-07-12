"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR, { mutate } from "swr"
import {
  Thermometer,
  Droplets,
  Users,
  Activity,
  HeartPulse,
  Smile,
  ThumbsUp,
  Sparkles,
  Target,
  Gauge,
  ChevronDown,
  Wind,
  Thermometer as ThermoIcon,
  AlertTriangle,
  History,
  Undo2,
} from "lucide-react"
import {
  happyBand,
  recommendations,
  type ActivityLevel,
  type AgeGroup,
  type ComfortProfile as Profile,
} from "@/lib/comfort/happy-number"
import {
  comfortFromConditions,
  comfortDetail,
  explainGap,
  monthCst,
  HAPPY_CLIMATE_GAP,
  type Capture,
} from "@/lib/comfort/ring"

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

export function ComfortProfilePanel() {
  const { data } = useSWR<{ ok: boolean; profile: ProfileRow | null }>(
    "/api/comfort/profile",
    fetcher,
  )

  // Capture log — if any captures exist, the comfort target is LEARNED, so a
  // manual slider change is an override that must be explicitly confirmed.
  const { data: capData } = useSWR<{ ok: boolean; captures: Capture[] }>(
    "/api/comfort/capture",
    fetcher,
  )
  const captureCount = capData?.captures?.length ?? 0

  const [form, setForm] = useState<ProfileRow>(DEFAULT_PROFILE)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [confirmOverride, setConfirmOverride] = useState(false)

  // The calculated TARGET comfort score these preferences produce (pure ASHRAE
  // 55, same math as the dual ring's outer arc). Updates live as sliders move.
  const month = useMemo(() => monthCst(), [])
  const targetScore = useMemo(
    () => comfortFromConditions(form.preferred_temp_f, form.preferred_rh, form, month),
    [form, month],
  )

  // Did the user change the learned comfort target (temp/humidity)?
  const targetChanged =
    data?.profile != null &&
    (Math.round(form.preferred_temp_f) !== Math.round(data.profile.preferred_temp_f) ||
      Math.round(form.preferred_rh) !== Math.round(data.profile.preferred_rh))

  // Hydrate the form once the saved profile loads.
  useEffect(() => {
    if (data?.profile && !dirty) {
      setForm({ ...DEFAULT_PROFILE, ...data.profile, health_considerations: data.profile.health_considerations ?? [] })
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

  // Gate: if the learned target changed AND captures exist, confirm first.
  function requestSave() {
    if (targetChanged && captureCount > 0) {
      setConfirmOverride(true)
      return
    }
    void save()
  }

  async function save() {
    setConfirmOverride(false)
    setSaving(true)
    try {
      await fetch("/api/comfort/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      })
      await mutate("/api/comfort/profile")
      setDirty(false)
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

        {/* Calculated Happy Number — matches the Happy Ring's blue target arc */}
        <div className="mt-5 flex items-center justify-between gap-3 rounded-xl border border-accent/30 bg-accent/5 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <Target className="h-5 w-5 shrink-0 text-accent" />
            <div>
              <p className="text-sm font-semibold text-foreground">Your Happy Number</p>
              <p className="text-xs text-muted-foreground text-pretty">
                Calculated from these preferences using ASHRAE Standard 55.
              </p>
            </div>
          </div>
          <span className="text-3xl font-bold tabular-nums text-accent">{targetScore}</span>
        </div>
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
        {captureCount > 0 ? (
          <p className="mb-3 flex items-start gap-2 rounded-lg border border-border bg-elevated px-3 py-2 text-xs text-muted-foreground text-pretty">
            <Target className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <span>
              Your comfort target is now <span className="font-medium text-foreground">learned</span> from{" "}
              {captureCount} training capture{captureCount === 1 ? "" : "s"}. Changing the sliders above
              overrides that learned target.
            </span>
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="font-semibold text-foreground">Save your comfort profile</p>
            <p className="text-sm text-muted-foreground text-pretty">
              Your dashboard uses this to tailor your comfort ring and recommendations.
            </p>
          </div>
          <button
            type="button"
            onClick={requestSave}
            disabled={saving}
            className="shrink-0 rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground transition-opacity disabled:opacity-60"
          >
            {saving ? "Saving…" : savedAt ? "Saved ✓" : "Save Changes"}
          </button>
        </div>
      </Card>

      {/* Override-confirmation dialog */}
      {confirmOverride ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="override-title"
        >
          <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-5 shadow-lg shadow-black/50">
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-warn/40 bg-warn/10">
                <AlertTriangle className="h-5 w-5 text-warn" />
              </span>
              <h3 id="override-title" className="text-base font-semibold text-foreground">
                Override your learned target?
              </h3>
            </div>
            <p className="mt-3 text-sm text-muted-foreground text-pretty">
              Elevate has learned your ideal comfort from {captureCount} training capture
              {captureCount === 1 ? "" : "s"}. Saving these slider values will replace that learned
              target with{" "}
              <span className="font-medium text-foreground">
                {Math.round(form.preferred_temp_f)}°F / {Math.round(form.preferred_rh)}%
              </span>{" "}
              until you train it again. Are you sure?
            </p>
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => setConfirmOverride(false)}
                className="flex-1 rounded-xl border border-border bg-elevated px-4 py-2.5 text-sm font-semibold text-foreground transition-colors hover:border-muted"
              >
                Keep learned target
              </button>
              <button
                type="button"
                onClick={save}
                className="flex-1 rounded-xl bg-warn px-4 py-2.5 text-sm font-semibold text-background transition-opacity hover:opacity-90"
              >
                Yes, override
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}

// ---- Dual Comfort Ring (target vs reality) ---------------------------------

type NestData = {
  ok: boolean
  configured: boolean
  connected: boolean
  thermostat: {
    ambientTempF: number | null
    humidity: number | null
  } | null
}

type AutomationFlags = {
  auto_comfort_enabled?: boolean
  peak_dodger_enabled?: boolean
}

// Self-contained HUD panel for the My Home view. Resolves the "reality" temp +
// humidity through the Nest→sensor fallback chain, scores BOTH target and
// reality as PURE ASHRAE comfort (100−PPD), and renders the dual ring.
export function HappyNumberPanel({
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
  // Nest is the primary reality source; dedupes with the Nest card's poll.
  const { data: nest } = useSWR<NestData>("/api/nest/data", fetcher, { refreshInterval: 300000 })
  // Automation flags drive the tap-to-explain copy ("we're handling this").
  const { data: profileRow } = useSWR<{ ok: boolean; profile: AutomationFlags | null }>(
    "/api/profile",
    fetcher,
  )

  const profile: Profile = data?.profile
    ? { ...DEFAULT_PROFILE, ...data.profile, health_considerations: data.profile.health_considerations ?? [] }
    : DEFAULT_PROFILE
  const hasProfile = data ? data.profile != null : null

  // Fallback chain: Nest ambient (primary) → return-air sensor (fallback).
  const nestLive =
    !!nest?.connected && nest.thermostat?.ambientTempF != null && nest.thermostat?.humidity != null
  const realityTempF = nestLive ? nest!.thermostat!.ambientTempF! : liveTempF
  const realityRh = nestLive ? nest!.thermostat!.humidity! : liveRh
  const source: "nest" | "sensor" = nestLive ? "nest" : "sensor"

  return (
    <ComfortRingCard
      profile={profile}
      hasProfile={hasProfile}
      isLoading={isLoading}
      realityTempF={realityTempF}
      realityRh={realityRh}
      source={source}
      nestConnected={!!nest?.connected}
      automation={profileRow?.profile ?? null}
      systemRunning={systemRunning}
    />
  )
}

function ComfortRingCard({
  profile,
  hasProfile,
  isLoading,
  realityTempF,
  realityRh,
  source,
  nestConnected,
  automation,
  systemRunning,
}: {
  profile: Profile
  hasProfile: boolean | null
  isLoading: boolean
  realityTempF: number | null
  realityRh: number | null
  source: "nest" | "sensor"
  nestConnected: boolean
  automation: AutomationFlags | null
  systemRunning: boolean
}) {
  const month = useMemo(() => monthCst(), [])
  const [explainOpen, setExplainOpen] = useState(false)

  // TARGET — fixed; pure comfort of the (learned) preferred conditions.
  const target = useMemo(
    () => comfortFromConditions(profile.preferred_temp_f, profile.preferred_rh, profile, month),
    [profile, month],
  )

  // REALITY — pure comfort of the live conditions; the only number that moves.
  const reality = useMemo(() => {
    if (realityTempF == null || realityRh == null) return null
    return comfortDetail(realityTempF, realityRh, profile, month).comfort
  }, [realityTempF, realityRh, profile, month])

  const gapInfo = useMemo(() => {
    if (realityTempF == null || realityRh == null) return null
    return explainGap({
      liveTempF: realityTempF,
      liveRh: realityRh,
      targetTempF: profile.preferred_temp_f,
      targetRh: profile.preferred_rh,
      profile,
      month,
    })
  }, [realityTempF, realityRh, profile, month])

  const recs = useMemo(() => {
    if (realityRh == null) return []
    return recommendations({ liveRh: realityRh, profile })
  }, [realityRh, profile])

  if (isLoading) {
    return (
      <Card>
        <CardHeader icon={<Gauge className="h-5 w-5 text-ok" />} title="Your Happy Ring" />
        <p className="text-sm text-muted">Loading your comfort profile…</p>
      </Card>
    )
  }

  if (hasProfile === false) {
    return (
      <Card>
        <CardHeader icon={<Gauge className="h-5 w-5 text-ok" />} title="Your Happy Ring" />
        <p className="text-sm text-muted-foreground text-pretty">
          Set your comfort profile in the Comfort Profile tab to see your live Happy Ring.
        </p>
      </Card>
    )
  }

  if (reality == null || gapInfo == null) {
    return (
      <Card>
        <CardHeader icon={<Gauge className="h-5 w-5 text-ok" />} title="Your Happy Ring" />
        <p className="text-sm text-muted-foreground">
          Waiting for a live indoor reading to score your comfort…
        </p>
      </Card>
    )
  }

  const realityBand = happyBand(reality)
  const dialedIn = gapInfo.withinRange
  const sourceLabel =
    source === "nest" ? "Live from your thermostat" : "Live from your return-air sensor"

  return (
    <Card>
      <CardHeader
        icon={<Gauge className="h-5 w-5 text-ok" />}
        title="Your Happy Ring"
        sub="Pure ASHRAE Standard 55 comfort — your Happy Number vs. your home's live Comfort Score right now."
      />

      {!systemRunning ? (
        <p className="mb-3 rounded-lg border border-border bg-elevated px-3 py-2 text-xs text-warn">
          Last known — system is resting. Scored on the most recent indoor air.
        </p>
      ) : null}

      <div className={`flex flex-col items-center rounded-2xl p-2 ${dialedIn ? "glow-ok" : ""}`}>
        <DualGauge
          reality={reality}
          target={target}
          realityColor={realityBand.color}
          tappable={!dialedIn}
          expanded={explainOpen}
          onToggle={() => setExplainOpen((v) => !v)}
        />
        {dialedIn ? (
          <p className="mt-3 flex items-center gap-1.5 text-center text-sm font-semibold text-ok text-pretty">
            <Sparkles className="h-4 w-4" /> Your home is dialed in
          </p>
        ) : (
          <p className={`mt-3 text-center text-sm font-medium text-pretty ${realityBand.color === "ok" ? "text-ok" : "text-warn"}`}>
            {realityBand.label}
          </p>
        )}
        <p className="mt-1 text-center text-[11px] text-muted">{sourceLabel}</p>
      </div>

      {/* Tap-to-explain (only when target & reality diverge) */}
      {!dialedIn ? (
        <button
          type="button"
          onClick={() => setExplainOpen((v) => !v)}
          aria-expanded={explainOpen}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-elevated px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {explainOpen ? "Hide the gap" : "Why the gap?"}
          <ChevronDown className={`h-4 w-4 transition-transform ${explainOpen ? "rotate-180" : ""}`} />
        </button>
      ) : null}

      {explainOpen && !dialedIn ? (
        <GapBreakdown
          gap={gapInfo}
          nestConnected={nestConnected}
          automationOn={!!automation?.auto_comfort_enabled}
        />
      ) : null}

      {/* Ideal (learned) targets */}
      <div className="mt-4 grid grid-cols-2 gap-3">
        <MiniStat label="Target Temp" value={`${Math.round(profile.preferred_temp_f)}°F`} />
        <MiniStat label="Target Humidity" value={`${Math.round(profile.preferred_rh)}%`} />
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

      {/* Training capture */}
      <CaptureTrainer realityTempF={realityTempF} realityRh={realityRh} source={source} />

      <p className="mt-4 text-center text-[11px] text-muted">
        An estimate — clothing and activity are inferred from your profile, not directly sensed.
      </p>
    </Card>
  )
}

// Plain-English breakdown of WHY reality diverges and WHAT closes it.
function GapBreakdown({
  gap,
  nestConnected,
  automationOn,
}: {
  gap: ReturnType<typeof explainGap>
  nestConnected: boolean
  automationOn: boolean
}) {
  const driverLabel =
    gap.primary === "temperature"
      ? "Temperature is the biggest factor"
      : gap.primary === "humidity"
        ? "Humidity is the biggest factor"
        : "You're close"

  // What would close it — target-aware, Nest-aware.
  let fix: string
  if (automationOn && nestConnected) {
    fix =
      gap.suggestedSetpointF != null
        ? `Elevate is handling this — adjusting toward ${gap.suggestedSetpointF}°F automatically.`
        : "Elevate is handling this automatically."
  } else if (nestConnected && gap.suggestedSetpointF != null) {
    fix = `Setting your thermostat to ${gap.suggestedSetpointF}°F would bring you into range.${
      gap.fanWouldHelp ? " Running the fan to circulate air would also help." : ""
    }`
  } else if (nestConnected && gap.fanWouldHelp) {
    fix = "Running the fan to circulate air would help close the gap."
  } else {
    fix =
      gap.suggestedSetpointF != null
        ? `Aim for about ${gap.suggestedSetpointF}°F. Connect your thermostat to let Elevate do this automatically.`
        : "Connect your thermostat to let Elevate adjust this automatically."
  }

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-xl border border-warn/30 bg-warn/5 p-4">
      <p className="text-sm text-foreground text-pretty">{gap.plain}</p>
      <div className="flex items-center gap-2 text-sm font-medium text-warn">
        {gap.primary === "humidity" ? (
          <Droplets className="h-4 w-4" />
        ) : (
          <ThermoIcon className="h-4 w-4" />
        )}
        {driverLabel}
      </div>
      <div className="flex items-start gap-2 rounded-lg border border-border bg-elevated p-3 text-sm text-muted-foreground text-pretty">
        {gap.fanWouldHelp ? (
          <Wind className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        ) : (
          <Target className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        )}
        <span>{fix}</span>
      </div>
      <p className="text-[11px] text-muted">Comfort gap: {gap.gap} points.</p>
    </div>
  )
}

// "I'm perfectly comfortable right now" — logs a capture and recomputes the
// learned target. This is the everyday Training Mode after first-time setup.
function CaptureTrainer({
  realityTempF,
  realityRh,
  source,
}: {
  realityTempF: number | null
  realityRh: number | null
  source: "nest" | "sensor"
}) {
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const [logOpen, setLogOpen] = useState(false)
  const ready = realityTempF != null && realityRh != null

  const { data: capData } = useSWR<{ ok: boolean; captures: Capture[] }>(
    "/api/comfort/capture",
    fetcher,
  )
  const captures = capData?.captures ?? []

  async function capture() {
    if (!ready) return
    setSaving(true)
    try {
      await fetch("/api/comfort/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ temp_f: realityTempF, rh: realityRh, source }),
      })
      await Promise.all([mutate("/api/comfort/profile"), mutate("/api/comfort/capture")])
      setDone(true)
      setTimeout(() => setDone(false), 3000)
    } finally {
      setSaving(false)
    }
  }

  // Undo the most recent capture — for an accidental "perfectly comfortable" tap.
  async function undo() {
    if (undoing || captures.length === 0) return
    setUndoing(true)
    try {
      await fetch("/api/comfort/capture", { method: "DELETE" })
      await Promise.all([mutate("/api/comfort/profile"), mutate("/api/comfort/capture")])
    } finally {
      setUndoing(false)
    }
  }

  return (
    <div className="mt-5 rounded-xl border border-ok/30 bg-ok/5 p-4">
      <h4 className="flex items-center gap-2 text-sm font-semibold text-ok">
        <ThumbsUp className="h-4 w-4" /> Training Mode
      </h4>
      <p className="mt-1 text-sm text-muted-foreground text-pretty">
        When your home feels exactly right, capture it. Elevate learns your ideal comfort from these
        captures (recent ones count more) instead of fixed sliders.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <MiniStat label="Current Temp" value={realityTempF != null ? `${Math.round(realityTempF)}°F` : "—"} />
        <MiniStat label="Current Humidity" value={realityRh != null ? `${Math.round(realityRh)}%` : "—"} />
      </div>
      <button
        type="button"
        onClick={capture}
        disabled={!ready || saving}
        className="mt-3 w-full rounded-xl bg-ok px-4 py-3 text-sm font-semibold text-background transition-opacity disabled:opacity-50"
      >
        {saving ? "Capturing…" : done ? "Captured — target updated ✓" : "I'm perfectly comfortable right now"}
      </button>

      {captures.length > 0 ? (
        <>
          <div className="mt-3 flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => setLogOpen((v) => !v)}
              aria-expanded={logOpen}
              className="flex items-center justify-center gap-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <History className="h-3.5 w-3.5" />
              {logOpen ? "Hide" : "Review"} {captures.length} capture{captures.length === 1 ? "" : "s"}
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${logOpen ? "rotate-180" : ""}`} />
            </button>
            <span className="text-muted" aria-hidden="true">
              ·
            </span>
            <button
              type="button"
              onClick={undo}
              disabled={undoing}
              className="flex items-center justify-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              <Undo2 className="h-3.5 w-3.5" />
              {undoing ? "Undoing…" : "Undo last"}
            </button>
          </div>
          {logOpen ? (
            <ul className="mt-2 flex max-h-44 flex-col gap-1.5 overflow-y-auto">
              {captures.map((cap) => (
                <li
                  key={`${cap.captured_at}-${cap.temp_f}`}
                  className="flex items-center justify-between rounded-lg border border-border bg-elevated px-3 py-2 text-xs"
                >
                  <span className="text-muted-foreground">{captureWhen(cap.captured_at)}</span>
                  <span className="tabular-nums text-foreground">
                    {Math.round(cap.temp_f)}°F · {Math.round(cap.rh)}%
                    <span className="ml-1.5 text-muted">{cap.source === "nest" ? "thermostat" : "sensor"}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

function captureWhen(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

// Dual-arc radial gauge: outer arc = TARGET, inner arc = REALITY (the big
// center number). Pure-comfort values 0–100.
function DualGauge({
  reality,
  target,
  realityColor,
  tappable,
  expanded,
  onToggle,
}: {
  reality: number
  target: number
  realityColor: "ok" | "warn" | "bad"
  tappable: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const size = 248
  const c = size / 2
  const rOuter = 110
  const rInner = 82
  const swOuter = 9
  const swInner = 14
  const cOuter = 2 * Math.PI * rOuter
  const cInner = 2 * Math.PI * rInner
  const pctTarget = Math.max(0, Math.min(100, target)) / 100
  const pctReality = Math.max(0, Math.min(100, reality)) / 100
  const realityStroke =
    realityColor === "ok" ? "var(--color-ok)" : realityColor === "warn" ? "var(--color-warn)" : "var(--color-bad)"
  const accentStroke = "var(--color-accent)"

  const ringEl = (
    <div className="relative" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} className="h-full w-full -rotate-90">
        {/* Outer track + TARGET arc (slim, blue) */}
        <circle cx={c} cy={c} r={rOuter} fill="none" stroke="var(--color-elevated)" strokeWidth={swOuter} />
        <circle
          cx={c}
          cy={c}
          r={rOuter}
          fill="none"
          stroke={accentStroke}
          strokeWidth={swOuter}
          strokeLinecap="round"
          strokeDasharray={cOuter}
          strokeDashoffset={cOuter * (1 - pctTarget)}
          style={{ transition: "stroke-dashoffset 0.7s ease" }}
        />
        {/* Inner track + REALITY arc (bold, band-colored) */}
        <circle cx={c} cy={c} r={rInner} fill="none" stroke="var(--color-elevated)" strokeWidth={swInner} />
        <circle
          cx={c}
          cy={c}
          r={rInner}
          fill="none"
          stroke={realityStroke}
          strokeWidth={swInner}
          strokeLinecap="round"
          strokeDasharray={cInner}
          strokeDashoffset={cInner * (1 - pctReality)}
          style={{ transition: "stroke-dashoffset 0.7s ease" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-6xl font-bold leading-none tabular-nums" style={{ color: realityStroke }}>
          {reality}
        </span>
        <span className="mt-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          comfort score
        </span>
      </div>
    </div>
  )

  const ring = tappable ? (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label="Explain the comfort gap"
      className="rounded-full outline-none ring-offset-4 ring-offset-card transition focus-visible:ring-2 focus-visible:ring-primary"
    >
      {ringEl}
    </button>
  ) : (
    ringEl
  )

  return (
    <div className="flex flex-col items-center">
      {ring}
      {/* Legend — numbers color-matched to their arcs */}
      <div className="mt-4 flex items-center gap-6">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: accentStroke }} aria-hidden="true" />
          <span className="text-xs text-muted-foreground">Happy Number</span>
          <span className="text-lg font-bold tabular-nums" style={{ color: accentStroke }}>
            {target}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: realityStroke }} aria-hidden="true" />
          <span className="text-xs text-muted-foreground">Comfort Score</span>
          <span className="text-lg font-bold tabular-nums" style={{ color: realityStroke }}>
            {reality}
          </span>
        </div>
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
