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
  MoreHorizontal,
  SlidersHorizontal,
  PiggyBank,
  Scale,
  Moon,
} from "lucide-react"
import {
  scoreAgainstBand,
  selectTarget,
  type ComfortBand,
  type ModelInputs,
  type ComfortFactor,
  type ComfortContext,
  type TargetSelection,
  type Constraint,
} from "@/lib/comfort/model"
import { type Capture } from "@/lib/comfort/ring"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

type ActivityLevel = "sedentary" | "moderate" | "active"
type Occupant = "seniors" | "adults" | "young_adults" | "children"

// The comfort profile row as stored — now driven by `occupants` (multi-select)
// rather than the old single age_group picker.
type ProfileRow = {
  preferred_temp_f: number
  preferred_rh: number
  occupants: Occupant[]
  activity_level: ActivityLevel
  household_size: number
  health_considerations: string[]
  anchor_set_at: string | null
  sleep_enabled: boolean
  sleep_start: string
  sleep_end: string
  sleep_target_f: number
}

// The derived model the server ships alongside the profile. Everything the ring
// and breakdown need to score LIVE reality client-side without re-deriving.
type ProfileModel = {
  happyNumber: number
  preferredScore: number
  factors: ComfortFactor[]
  band: ComfortBand
  inputs: ModelInputs
  ctx: ComfortContext
  summary: {
    tLo: number
    tHi: number
    rhLo: number
    rhHi: number
    targetTempF: number
    targetRh: number
    empty: boolean
    dropped: string[]
    tolerance: number
  }
  preferredBelowFloor: boolean
  preferredFloor: number | null
}

const DEFAULT_PROFILE: ProfileRow = {
  preferred_temp_f: 72,
  preferred_rh: 45,
  occupants: ["adults"],
  activity_level: "moderate",
  household_size: 2,
  health_considerations: [],
  anchor_set_at: null,
  sleep_enabled: true,
  sleep_start: "22:00",
  sleep_end: "06:00",
  sleep_target_f: 72,
}

const OCCUPANT_OPTIONS: { value: Occupant; label: string; sub: string }[] = [
  { value: "seniors", label: "Seniors", sub: "55+ — needs it no cooler than 70°F" },
  { value: "adults", label: "Adults", sub: "36-55" },
  { value: "young_adults", label: "Young Adults", sub: "18-35" },
  { value: "children", label: "Young Children", sub: "needs it no warmer than 76°F" },
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

// Comfort Score vs Happy Number → label + semantic color for the reality arc /
// status line. Under the typical-anchored scale (spec v2.4 §3.2) the score is
// NOT "higher is better" — the home is on target when the score EQUALS the
// Happy Number, and drifting either way (toward generic OR past their ideal)
// is worse. So the label is keyed off the DEVIATION between the two numbers,
// with a warmer/cooler cue for direction.
function comfortStatus(score: number, happy: number, warmer: boolean): { label: string; color: "ok" | "warn" } {
  const d = Math.abs(score - happy)
  const dir = warmer ? "warm" : "cool"
  if (d <= 6) return { label: "On your comfort target", color: "ok" }
  if (d <= 15) return { label: `Slightly ${dir} of your target`, color: "warn" }
  if (d <= 30) return { label: `Running ${dir} of your target`, color: "warn" }
  return { label: `Well ${dir} of your target`, color: "warn" }
}

// A plain-English gap breakdown derived entirely from the unified model's
// scoreAgainstBand() output + the household band. Replaces the old explainGap.
type GapView = {
  gap: number
  withinRange: boolean
  primary: "temperature" | "humidity" | "none"
  plain: string
  fanWouldHelp: boolean
  suggestedSetpointF: number | null
}

// A factor's code tells us which axis it binds on.
const HUMIDITY_CODES = new Set([
  "respiratory_humidity_floor",
  "allergen_humidity_ceiling",
  "asthma_humidity_ceiling",
  "respiratory_humidity_ceiling",
])
const TEMP_CODES = new Set([
  "senior_thermal_floor",
  "child_activity_ceiling",
  "sleep_night_window",
])

function factorAxis(code: string, tempF: number, rh: number, band: ComfortBand): GapView["primary"] {
  if (HUMIDITY_CODES.has(code)) return "humidity"
  if (TEMP_CODES.has(code)) return "temperature"
  if (code === "thermal") return "temperature"
  // Fallback: whichever edge the point is further outside of.
  const dRh = rh > band.rhHi ? rh - band.rhHi : rh < band.rhLo ? band.rhLo - rh : 0
  const dT = tempF > band.tHi ? tempF - band.tHi : tempF < band.tLo ? band.tLo - tempF : 0
  return dRh > dT ? "humidity" : "temperature"
}

function buildGap(
  realityTempF: number,
  realityRh: number,
  band: ComfortBand,
  inputs: ModelInputs,
  ctx: ComfortContext,
): { view: GapView; factors: ComfortFactor[] } {
  const detail = scoreAgainstBand(realityTempF, realityRh, band, inputs, ctx)
  // Comfort Score and Happy Number now live on the SAME typical-anchored scale
  // (spec v2.4 §3.2): the score reads the Happy Number when the home is exactly
  // at target and moves away in EITHER direction as conditions drift. So the gap
  // is the absolute deviation, and dialed-in is |score − happy| ≤ tolerance —
  // NOT the old one-sided "score ≥ happy − tol", which read a too-warm home
  // (score above happy) as dialed in.
  const deviation = Math.abs(detail.score - band.happyNumber)
  const gap = Math.round(deviation)
  const withinRange = deviation <= 5 + band.tolerance

  const binding = detail.factors.filter((f) => f.severity === "binding")
  // Primary driver = the axis of the first binding constraint (respiratory
  // floor is listed first when multiple bind).
  const primary: GapView["primary"] = withinRange
    ? "none"
    : binding.length
      ? factorAxis(binding[0].code, realityTempF, realityRh, band)
      : "none"

  // The exact target the engine drives to (household preference clamped to the
  // slice at current humidity, spec §5) — also gives the direction of the miss.
  const targetTempF = selectTarget(band, inputs, realityRh).targetTempF
  const warmer = realityTempF > targetTempF

  const plain = withinRange
    ? "Your home is right at your household's comfort target."
    : binding[0]?.label
      ? `Your home reads ${Math.round(realityTempF)}°F / ${Math.round(realityRh)}% — ${binding[0].label}.`
      : `Your home reads ${Math.round(realityTempF)}°F / ${Math.round(realityRh)}% — ${warmer ? "warmer" : "cooler"} than your ${Math.round(targetTempF)}°F target.`

  const suggestedSetpointF =
    primary === "temperature" || (primary === "none" && !withinRange) ? Math.round(targetTempF) : null
  const fanWouldHelp = primary === "humidity"

  return { view: { gap, withinRange, primary, plain, fanWouldHelp, suggestedSetpointF }, factors: detail.factors }
}

// Recommendations derived from the binding + conflict factors.
function recsFromFactors(factors: ComfortFactor[]): string[] {
  return factors.filter((f) => f.severity !== "good").map((f) => f.label)
}

export function ComfortProfilePanel() {
  const { data } = useSWR<{ ok: boolean; profile: ProfileRow | null; model: ProfileModel | null }>(
    "/api/comfort/profile",
    fetcher,
  )
  const model = data?.model ?? null

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

  // The Happy Number — the household fingerprint (band width + centrality),
  // derived server-side from the full six-input model. It is NOT a function of
  // the temp/humidity sliders (those set the target the system trains toward),
  // so it stays stable until the demographics/health inputs change and save.
  const targetScore = model?.happyNumber ?? 0

  // Did the user change the learned comfort target (temp/humidity)?
  const targetChanged =
    data?.profile != null &&
    (Math.round(form.preferred_temp_f) !== Math.round(data.profile.preferred_temp_f) ||
      Math.round(form.preferred_rh) !== Math.round(data.profile.preferred_rh))

  // Hydrate the form once the saved profile loads. Postgres `time` comes back as
  // "HH:MM:SS"; the time inputs want "HH:MM". sleep_target defaults to the
  // preferred temperature (spec v2.3 §8.2) when the row predates the column.
  useEffect(() => {
    if (data?.profile && !dirty) {
      const p = data.profile
      setForm({
        ...DEFAULT_PROFILE,
        ...p,
        health_considerations: p.health_considerations ?? [],
        sleep_enabled: p.sleep_enabled ?? true,
        sleep_start: String(p.sleep_start ?? "22:00").slice(0, 5),
        sleep_end: String(p.sleep_end ?? "06:00").slice(0, 5),
        sleep_target_f: p.sleep_target_f ?? p.preferred_temp_f ?? 72,
      })
    }
  }, [data, dirty])

  const set = <K extends keyof ProfileRow>(key: K, value: ProfileRow[K]) => {
    setForm((f) => ({ ...f, [key]: value }))
    setDirty(true)
  }

  const toggleOccupant = (v: Occupant) => {
    setForm((f) => {
      const has = f.occupants.includes(v)
      return { ...f, occupants: has ? f.occupants.filter((x) => x !== v) : [...f.occupants, v] }
    })
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
                How specific your household&apos;s ideal climate is — from your preferences and health needs
                against an ASHRAE Standard 55 comfort envelope.
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
        <FieldLabel icon={<Users className="h-4 w-4 text-muted" />}>Who lives here?</FieldLabel>
        <p className="mb-2 text-xs text-muted">
          Select everyone — these intersect to narrow your comfort range, they don&apos;t average.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {OCCUPANT_OPTIONS.map((o) => {
            const active = form.occupants.includes(o.value)
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => toggleOccupant(o.value)}
                aria-pressed={active}
                className={`flex flex-col rounded-xl border px-3 py-2.5 text-left transition-colors ${
                  active ? "border-primary bg-primary/10" : "border-border bg-elevated hover:border-muted"
                }`}
              >
                <span className="text-sm font-semibold text-foreground">{o.label}</span>
                <span className="text-[11px] leading-snug text-muted">{o.sub}</span>
              </button>
            )
          })}
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

      {/* Sleep Schedule (spec v2.3 §8) */}
      <Card>
        <CardHeader
          icon={<Moon className="h-5 w-5 text-primary" />}
          title="Sleep Schedule"
          sub="Overnight we target your sleep temperature instead of your daytime preference"
        />
        <label className="flex items-center justify-between gap-3 rounded-xl border border-border bg-elevated px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-foreground">Enable sleep schedule</p>
            <p className="text-xs text-muted">When off, your daytime target runs 24/7.</p>
          </div>
          <input
            type="checkbox"
            checked={form.sleep_enabled}
            onChange={(e) => set("sleep_enabled", e.target.checked)}
            className="h-5 w-5 accent-primary"
            aria-label="Enable sleep schedule"
          />
        </label>

        {form.sleep_enabled ? (
          <>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <FieldLabel icon={<Moon className="h-4 w-4 text-muted" />}>Sleep starts</FieldLabel>
                <input
                  type="time"
                  value={form.sleep_start}
                  onChange={(e) => set("sleep_start", e.target.value)}
                  className="w-full rounded-xl border border-border bg-elevated px-3 py-2.5 text-sm text-foreground [color-scheme:dark]"
                />
              </div>
              <div>
                <FieldLabel icon={<Thermometer className="h-4 w-4 text-muted" />}>Wake up</FieldLabel>
                <input
                  type="time"
                  value={form.sleep_end}
                  onChange={(e) => set("sleep_end", e.target.value)}
                  className="w-full rounded-xl border border-border bg-elevated px-3 py-2.5 text-sm text-foreground [color-scheme:dark]"
                />
              </div>
            </div>
            <SliderRow
              icon={<Thermometer className="h-4 w-4 text-muted" />}
              label="Sleep Temperature"
              value={`${Math.round(form.sleep_target_f)}°F`}
              min={60}
              max={78}
              step={1}
              val={form.sleep_target_f}
              onChange={(v) => set("sleep_target_f", v)}
              ticks={["60°F (Cool)", "68°F", "78°F (Warm)"]}
            />
            <p className="mt-1 text-xs text-muted text-pretty">
              Defaults to your daytime preference. Set it lower for a cooler night — we&apos;ll drive to it during
              your sleep window and never quietly walk it back up.
            </p>
          </>
        ) : null}
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
  const { data, isLoading } = useSWR<{
    ok: boolean
    profile: ProfileRow | null
    model: ProfileModel | null
  }>("/api/comfort/profile", fetcher)
  // Nest is the primary reality source; dedupes with the Nest card's poll.
  const { data: nest } = useSWR<NestData>("/api/nest/data", fetcher, { refreshInterval: 300000 })
  // Automation flags drive the tap-to-explain copy ("we're handling this").
  const { data: profileRow } = useSWR<{ ok: boolean; profile: AutomationFlags | null }>(
    "/api/profile",
    fetcher,
  )

  const model = data?.model ?? null
  const hasProfile = data ? data.profile != null : null

  // Fallback chain: Nest ambient (primary) → return-air sensor (fallback).
  const nestLive =
    !!nest?.connected && nest.thermostat?.ambientTempF != null && nest.thermostat?.humidity != null
  const realityTempF = nestLive ? nest!.thermostat!.ambientTempF! : liveTempF
  const realityRh = nestLive ? nest!.thermostat!.humidity! : liveRh
  const source: "nest" | "sensor" = nestLive ? "nest" : "sensor"

  return (
    <ComfortRingCard
      model={model}
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
  model,
  hasProfile,
  isLoading,
  realityTempF,
  realityRh,
  source,
  nestConnected,
  automation,
  systemRunning,
}: {
  model: ProfileModel | null
  hasProfile: boolean | null
  isLoading: boolean
  realityTempF: number | null
  realityRh: number | null
  source: "nest" | "sensor"
  nestConnected: boolean
  automation: AutomationFlags | null
  systemRunning: boolean
}) {
  const [explainOpen, setExplainOpen] = useState(false)
  // Collapsed by default: card shows just the title + ring until expanded.
  const [cardExpanded, setCardExpanded] = useState(false)
  const [recsOpen, setRecsOpen] = useState(false)

  // TARGET — the household Happy Number (band fingerprint), stable all day.
  const target = model?.happyNumber ?? 0

  // REALITY — Comfort Score of the live conditions against the baseline band;
  // the only number that moves. Scored with the SAME pure model as the engine.
  const reality = useMemo(() => {
    if (model == null || realityTempF == null || realityRh == null) return null
    return scoreAgainstBand(realityTempF, realityRh, model.band, model.inputs, model.ctx).score
  }, [model, realityTempF, realityRh])

  const gapData = useMemo(() => {
    if (model == null || realityTempF == null || realityRh == null) return null
    return buildGap(realityTempF, realityRh, model.band, model.inputs, model.ctx)
  }, [model, realityTempF, realityRh])
  const gapInfo = gapData?.view ?? null

  const recs = useMemo(() => {
    if (gapData == null) return []
    return recsFromFactors(gapData.factors)
  }, [gapData])

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

  const warmer =
    model != null && realityTempF != null && realityRh != null
      ? realityTempF > selectTarget(model.band, model.inputs, realityRh).targetTempF
      : true
  const realityBand = comfortStatus(reality, target, warmer)
  const dialedIn = gapInfo.withinRange
  const sourceLabel =
    source === "nest" ? "Live from your thermostat" : "Live from your return-air sensor"

  return (
    <Card>
      <CardHeader icon={<Gauge className="h-5 w-5 text-ok" />} title="Your Happy Ring" />

      <AutomationModeToggles />

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

      {/* "..." — reveal targets, the gap breakdown, recs, and training */}
      <button
        type="button"
        onClick={() => setCardExpanded((v) => !v)}
        aria-expanded={cardExpanded}
        aria-label={cardExpanded ? "Hide details" : "Show details"}
        className="mx-auto mt-3 flex h-8 items-center justify-center gap-1.5 rounded-full border border-border bg-elevated px-4 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {cardExpanded ? "Less" : "More"}
        <MoreHorizontal className="h-4 w-4" />
      </button>

      {cardExpanded ? (
        <>
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

          {/* What we're targeting (spec v2.3 §4.2) — the preferred target, not a
              range. A limit line appears ONLY when a health constraint overrides
              preference, judged against the conditional slice at CURRENT humidity
              (§4.1), never the temperature-axis projection. */}
          {model && realityRh != null ? (
            <TargetLine
              target={selectTarget(model.band, model.inputs, realityRh)}
              inputs={model.inputs}
              active={model.band.active}
            />
          ) : null}

          {/* Recommendations — title only, collapsible */}
          {recs.length > 0 ? (
            <div className="mt-5">
              <button
                type="button"
                onClick={() => setRecsOpen((v) => !v)}
                aria-expanded={recsOpen}
                className="flex w-full items-center gap-2 text-sm font-semibold text-foreground"
              >
                <Sparkles className="h-4 w-4 text-primary" /> Personalized Recommendations
                <ChevronDown className={`ml-auto h-4 w-4 text-muted transition-transform ${recsOpen ? "rotate-180" : ""}`} />
              </button>
              {recsOpen ? (
                <ul className="mt-2 flex flex-col gap-2">
                  {recs.map((r) => (
                    <li key={r} className="flex items-start gap-2 text-sm text-muted-foreground text-pretty">
                      <ThumbsUp className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {/* Training capture */}
          <CaptureTrainer realityTempF={realityTempF} realityRh={realityRh} source={source} />

          <p className="mt-4 text-center text-[11px] text-muted">
            An estimate — clothing and activity are inferred from your profile, not directly sensed.
          </p>
        </>
      ) : null}
    </Card>
  )
}

// Plain-English breakdown of WHY reality diverges and WHAT closes it.
function GapBreakdown({
  gap,
  nestConnected,
  automationOn,
}: {
  gap: GapView
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
  // Collapsed by default: shows just the Capture button until expanded.
  const [trainerExpanded, setTrainerExpanded] = useState(false)
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
      <div className="flex items-center justify-between gap-3">
        <h4 className="flex items-center gap-2 text-sm font-semibold text-ok">
          <ThumbsUp className="h-4 w-4" /> Training Mode
        </h4>
        <button
          type="button"
          onClick={() => setTrainerExpanded((v) => !v)}
          aria-expanded={trainerExpanded}
          aria-label={trainerExpanded ? "Hide training details" : "Show training details"}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-elevated text-muted transition-colors hover:text-foreground"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </div>

      {/* The smart button — always visible */}
      <button
        type="button"
        onClick={capture}
        disabled={!ready || saving}
        className="mt-3 w-full rounded-xl bg-ok px-4 py-3 text-sm font-semibold text-background transition-opacity disabled:opacity-50"
      >
        {saving ? "Capturing…" : done ? "Captured ✓" : "Capture — I'm comfortable now"}
      </button>

      {trainerExpanded ? (
        <>
          <p className="mt-3 text-sm text-muted-foreground text-pretty">
            When your home feels exactly right, capture it. Elevate learns your ideal comfort from these
            captures (recent ones count more) instead of fixed sliders.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <MiniStat label="Current Temp" value={realityTempF != null ? `${Math.round(realityTempF)}°F` : "—"} />
            <MiniStat label="Current Humidity" value={realityRh != null ? `${Math.round(realityRh)}%` : "—"} />
          </div>
        </>
      ) : null}

      {trainerExpanded && captures.length > 0 ? (
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

type ModeTriple = { manual: boolean; comfort: boolean; savings: boolean }
type ModeResp = { ok: boolean; flags: ModeTriple; mode: string; error?: string }

const BALANCED_TRIPLE: ModeTriple = { manual: false, comfort: true, savings: true }

// Resolve the next toggle state from a tap, enforcing the two hard rules:
// - Manual is exclusive: selecting it forces Comfort and Savings off.
// - The state is never empty: turning off the last active mode snaps to Balanced.
function nextTriple(cur: ModeTriple, target: "manual" | "comfort" | "savings"): ModeTriple {
  if (target === "manual") {
    // Re-tapping Manual (the only thing on) would empty the state → Balanced.
    return cur.manual ? BALANCED_TRIPLE : { manual: true, comfort: false, savings: false }
  }
  // Leaving Manual: start from a clean non-manual base, then flip the target.
  let comfort = cur.manual ? false : cur.comfort
  let savings = cur.manual ? false : cur.savings
  if (target === "comfort") comfort = cur.manual ? true : !cur.comfort
  if (target === "savings") savings = cur.manual ? true : !cur.savings
  if (!comfort && !savings) return BALANCED_TRIPLE
  return { manual: false, comfort, savings }
}

// The three automation toggles that replace the old ASHRAE subtitle. Comfort +
// Savings together form the Balanced hybrid; Manual stands alone. Writes go
// through /api/automation/mode, which is backstopped by the DB CHECK constraint.
function AutomationModeToggles() {
  const { data } = useSWR<ModeResp>("/api/automation/mode", fetcher)
  const [optimistic, setOptimistic] = useState<ModeTriple | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const flags = optimistic ?? data?.flags ?? BALANCED_TRIPLE
  const balanced = !flags.manual && flags.comfort && flags.savings

  async function choose(target: "manual" | "comfort" | "savings") {
    const next = nextTriple(flags, target)
    if (next.manual === flags.manual && next.comfort === flags.comfort && next.savings === flags.savings) {
      return
    }
    setOptimistic(next)
    setError(null)
    setSaving(true)
    try {
      const res = await fetch("/api/automation/mode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      })
      const json = (await res.json()) as ModeResp
      if (!res.ok || !json.ok) {
        // Surface the DB constraint / server error and revert the optimistic UI.
        setError(json.error ?? "Couldn't update automation mode.")
        setOptimistic(null)
      } else {
        setOptimistic(null)
        mutate("/api/automation/mode")
      }
    } catch {
      setError("Network error — automation mode not saved.")
      setOptimistic(null)
    } finally {
      setSaving(false)
    }
  }

  const items = [
    { key: "manual" as const, label: "Manual", desc: "I run my own system", Icon: SlidersHorizontal, active: flags.manual },
    { key: "comfort" as const, label: "Comfort", desc: "Hold my Happy Number", Icon: Smile, active: !flags.manual && flags.comfort },
    { key: "savings" as const, label: "Savings", desc: "Trim cost I won't notice", Icon: PiggyBank, active: !flags.manual && flags.savings },
  ]

  return (
    <div className="mb-4">
      <div className="grid grid-cols-3 gap-2">
        {items.map(({ key, label, desc, Icon, active }) => (
          <button
            key={key}
            type="button"
            role="switch"
            aria-checked={active}
            aria-label={`${label}: ${desc}`}
            disabled={saving}
            onClick={() => choose(key)}
            className={`flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-center transition-colors disabled:opacity-60 ${
              active ? "border-primary bg-primary/10" : "border-border bg-elevated hover:border-muted"
            }`}
          >
            <Icon className={`h-4 w-4 ${active ? "text-primary" : "text-muted"}`} aria-hidden="true" />
            <span className={`text-sm font-semibold ${active ? "text-foreground" : "text-muted"}`}>{label}</span>
            <span className="text-[11px] font-medium leading-snug tracking-wide text-muted text-pretty">{desc}</span>
          </button>
        ))}
      </div>
      {balanced ? (
        <p className="mt-2 flex items-center justify-center gap-1.5 rounded-lg border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs font-medium text-primary">
          <Scale className="h-3.5 w-3.5" aria-hidden="true" /> Balanced — save where comfort allows
        </p>
      ) : null}
      {error ? (
        <p className="mt-2 rounded-lg border border-warn/30 bg-warn/5 px-3 py-1.5 text-xs text-warn text-pretty" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

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

// §4.2 — "Targeting 68°F." plus a limit line ONLY when a health constraint
// actually overrode preference. No range is shown.
function TargetLine({
  target,
  inputs,
  active,
}: {
  target: TargetSelection
  inputs: ModelInputs
  active: Constraint[]
}) {
  const has = (name: string) => active.some((c) => c.constraint_name === name)
  let limit: string | null = null
  if (target.tempClampedBy === "floor") {
    limit = `Targeting ${Math.round(target.targetTempF)}°F rather than your ${Math.round(
      inputs.preferred_temp_f,
    )}°F, because a senior in the household needs a warmer floor.`
  } else if (target.tempClampedBy === "ceiling") {
    limit = `Targeting ${Math.round(target.targetTempF)}°F rather than your ${Math.round(
      inputs.preferred_temp_f,
    )}°F, because young children need it no warmer.`
  } else if (target.rhClampedBy === "floor") {
    limit = `Holding humidity at or above ${Math.round(target.targetRh)}% for ${
      has("respiratory_humidity_floor") ? "asthma" : "your household's needs"
    }.`
  } else if (target.rhClampedBy === "ceiling") {
    limit = `Holding humidity at or below ${Math.round(target.targetRh)}% for ${
      has("allergen_humidity_ceiling") ? "allergies" : "asthma"
    }.`
  }

  return (
    <div className="mt-4 rounded-xl border border-accent/30 bg-accent/5 px-4 py-3">
      <p className="text-[10px] uppercase tracking-wider text-muted">Targeting</p>
      <p className="mt-0.5 text-xl font-semibold tabular-nums text-foreground">
        {Math.round(target.targetTempF)}°F
        <span className="ml-1 text-sm font-normal text-muted-foreground">/ {Math.round(target.targetRh)}%</span>
      </p>
      {limit ? <p className="mt-2 text-[12px] leading-snug text-muted-foreground text-pretty">{limit}</p> : null}
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
