import "server-only"
import { createAdminClient } from "@/lib/supabase/admin"
import { computeLiveReading } from "@/lib/compute-reading"
import {
  fetchThermostat,
  applyControl,
  getFreshAccessToken,
  nestConfigured,
  cacheHvacStatus,
  NestAuthError,
  NestRateLimitError,
  type NestThermostat,
} from "@/lib/nest/client"
import { clampSetpoint } from "@/lib/comfort/ring"
import { comfortContext, deriveBandCached } from "@/lib/comfort/load"
import { scoreAgainstBand, type ComfortBand, type ModelInputs, coerceConstraint, DEFAULT_MODEL_INPUTS } from "@/lib/comfort/model"
import {
  RTOU_RATES,
  seasonForMonth,
  toCstParts,
  isRtouHoliday,
  type Season,
} from "@/lib/engine/cost"

// ---------------------------------------------------------------------------
// Automation engine — server-side. Runs the two installer-enrolled automations
// (Automatic Comfort Adjustment + Peak Dodger) with HARD temperature clamps,
// read-back confirmation, and an honest journal. Nest data here is used ONLY
// to display/control comfort; it never feeds computed_readings, the SEER calc,
// or the cost engine. When Nest is not connected, automations downgrade to
// recommendation journal rows and NEVER actuate.
// ---------------------------------------------------------------------------

const SITE_ID = "default"

// --- TWO DISTINCT THROTTLE TIMERS ------------------------------------------
// 1) EVALUATION CADENCE — how often the engine *thinks*. This is set by the
//    Supabase pg_cron schedule (every 5 minutes). Recorded here for clarity;
//    the cron is the source of truth.
const EVALUATION_CADENCE_MS = 5 * 60 * 1000
// 2) ACTUATION COOLDOWN — how often the engine is *allowed to send a command*
//    to the thermostat. Deliberately longer than the evaluation cadence so the
//    setpoint can't oscillate (up/down/up) as conditions cross a threshold.
//    Sits on top of the Nest client's 429 exponential backoff.
const ACTUATION_COOLDOWN_MS = 12 * 60 * 1000

// Don't repeat the same recommendation more than once per hour.
const RECO_COOLDOWN_MS = 60 * 60 * 1000
// Heartbeat: when a tick takes no action, log an "evaluation" row at most this
// often, so the journal proves the engine is running without flooding it
// (a row every 5-min tick would be 288/day; this caps it to ~48/day).
const HEARTBEAT_MS = 30 * 60 * 1000
// Single comfort nudge step (°F). Spec §6: "Move in 1°F steps toward the
// centroid, never jump."
const COMFORT_STEP_F = 1
// Hard safety floor — the setpoint may never be pushed below this while hunting
// (spec §6: "Never cross the 68°F safety floor").
const SAFETY_FLOOR_F = 68
// Savings mode widens the comfort deadband by this many points so the engine
// tolerates drift and only intervenes when comfort really falls below the band.
const SAVINGS_DRIFT_POINTS = 8
// Confirmation tolerance — SDM rounds to ~0.5°C, so allow ~1°F slack.
const CONFIRM_TOLERANCE_F = 1

export type TickResult = { ran: boolean; action: string | null; detail?: string }

type AutomationMode = "manual" | "comfort" | "savings" | "balanced"

type BeforeState = {
  temp_f: number
  rh: number
  setpoint_f: number | null
  comfort_score: number
  // The active automation mode at evaluation time. Persisted on EVERY journal
  // row so a savings figure can later be explained ("Savings was off that
  // week" must be answerable from the data alone).
  mode: AutomationMode
}

// SupabaseClient is loosely typed in this project; alias for readability.
type Db = ReturnType<typeof createAdminClient>

async function getNestTokenSafe(): Promise<string | null> {
  if (!nestConfigured()) return null
  try {
    return await getFreshAccessToken()
  } catch {
    // Auth/refresh failure → treat as not connected; automations become recs.
    return null
  }
}

function estPeakSavingsUsd(watts: number | null, season: Season): number {
  if (watts == null || !Number.isFinite(watts)) return 0
  const rates = RTOU_RATES[season]
  const delta = rates.on_peak - rates.off_peak
  // ≈ one hour of current draw shifted out of the peak window.
  const kwh = (watts / 1000) * 1
  return Math.round(kwh * delta * 10000) / 10000
}

async function insertJournal(
  db: Db,
  row: {
    action_type: string
    trigger_reason: string
    command_sent: Record<string, unknown> | null
    nest_confirmed: boolean | null
    before_state: BeforeState | null
    est_savings_usd?: number | null
    est_comfort_delta?: number | null
  },
): Promise<void> {
  await db.from("automation_journal").insert({
    site_id: SITE_ID,
    occurred_at: new Date().toISOString(),
    ...row,
    est_savings_usd: row.est_savings_usd ?? null,
    est_comfort_delta: row.est_comfort_delta ?? null,
  })
}

// Most recent actuation (command actually sent), for the cooldown check.
async function lastActuationTime(db: Db): Promise<number | null> {
  const { data } = await db
    .from("automation_journal")
    .select("occurred_at")
    .eq("site_id", SITE_ID)
    .not("command_sent", "is", null)
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  return data?.occurred_at ? new Date(data.occurred_at).getTime() : null
}

// Has a given action already happened on the current CST calendar day?
async function didActionToday(db: Db, actionType: string, nowMs: number): Promise<boolean> {
  const since = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString()
  const { data } = await db
    .from("automation_journal")
    .select("occurred_at, action_type")
    .eq("site_id", SITE_ID)
    .eq("action_type", actionType)
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: false })
    .limit(10)
  if (!data?.length) return false
  const today = toCstParts(new Date(nowMs))
  return data.some((r) => {
    const p = toCstParts(new Date(r.occurred_at))
    return p.year === today.year && p.month === today.month && p.day === today.day
  })
}

// Throttle recommendations so we don't spam the journal each tick.
async function maybeRecommend(db: Db, key: string, reason: string, before: BeforeState): Promise<boolean> {
  const since = new Date(Date.now() - RECO_COOLDOWN_MS).toISOString()
  const { data } = await db
    .from("automation_journal")
    .select("id, trigger_reason")
    .eq("site_id", SITE_ID)
    .eq("action_type", "recommendation")
    .gte("occurred_at", since)
    .limit(20)
  const already = (data ?? []).some((r) => (r.trigger_reason ?? "").startsWith(`[${key}]`))
  if (already) return false
  await insertJournal(db, {
    action_type: "recommendation",
    trigger_reason: `[${key}] ${reason}`,
    command_sent: null,
    nest_confirmed: null,
    before_state: before,
  })
  return true
}

// Heartbeat — log a throttled "evaluation, no change needed" row so the
// journal proves the cron engine is alive, without flooding every 5 min.
async function maybeHeartbeat(db: Db, detail: string, before: BeforeState): Promise<boolean> {
  const since = new Date(Date.now() - HEARTBEAT_MS).toISOString()
  const { data } = await db
    .from("automation_journal")
    .select("id")
    .eq("site_id", SITE_ID)
    .eq("action_type", "evaluation")
    .gte("occurred_at", since)
    .limit(1)
  if (data?.length) return false
  await insertJournal(db, {
    action_type: "evaluation",
    trigger_reason: `Evaluated — ${detail}`,
    command_sent: null,
    nest_confirmed: null,
    before_state: before,
  })
  return true
}

// Phase 1 — confirm the most recent pending command against live Nest state.
async function confirmPending(
  db: Db,
  thermostat: NestThermostat | null,
  inputs: ModelInputs,
  band: ComfortBand,
  ctx: { month: number; blower_on: boolean; night: boolean },
): Promise<void> {
  if (!thermostat) return
  const { data: pending } = await db
    .from("automation_journal")
    .select("*")
    .eq("site_id", SITE_ID)
    .is("nest_confirmed", null)
    .not("command_sent", "is", null)
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!pending) return

  const cmd = (pending.command_sent ?? {}) as { coolSetpoint?: number; fan?: string }
  let confirmed = false
  if (typeof cmd.coolSetpoint === "number" && thermostat.coolSetpointF != null) {
    confirmed = Math.abs(thermostat.coolSetpointF - cmd.coolSetpoint) <= CONFIRM_TOLERANCE_F
  } else if (cmd.fan === "ON") {
    confirmed = thermostat.fanMode === "ON"
  }

  const afterComfort =
    thermostat.ambientTempF != null && thermostat.humidity != null
      ? scoreAgainstBand(thermostat.ambientTempF, thermostat.humidity, band, inputs, ctx).score
      : null
  const beforeComfort = (pending.before_state as BeforeState | null)?.comfort_score ?? null

  await db
    .from("automation_journal")
    .update({
      nest_confirmed: confirmed,
      after_state: {
        temp_f: thermostat.ambientTempF,
        rh: thermostat.humidity,
        setpoint_f: thermostat.coolSetpointF,
        comfort_score: afterComfort,
      },
      est_comfort_delta:
        afterComfort != null && beforeComfort != null ? afterComfort - beforeComfort : null,
    })
    .eq("id", pending.id)
}

export async function runAutomationTick(): Promise<TickResult> {
  const db = createAdminClient()

  const [{ data: sys }, { data: comfortRaw }, inputsRes, constraintsRes, modeRes] = await Promise.all([
    db.from("system_profile").select("*").eq("site_id", SITE_ID).maybeSingle(),
    db.from("comfort_profile").select("*").eq("site_id", SITE_ID).maybeSingle(),
    db.rpc("comfort_model_inputs", { p_site_id: SITE_ID }),
    db.rpc("comfort_band_constraints", { p_site_id: SITE_ID }),
    db.rpc("current_automation_mode", { p_site_id: SITE_ID }),
  ])

  const autoComfort = !!sys?.auto_comfort_enabled
  const peakDodger = !!sys?.peak_dodger_enabled
  if (!autoComfort && !peakDodger) return { ran: false, action: null, detail: "no automations enabled" }
  if (!comfortRaw) return { ran: false, action: null, detail: "no comfort profile" }

  // The user's active automation mode. Balanced (comfort+savings) is the
  // default; treat anything unexpected as balanced so we never act rogue.
  const rawMode = String(modeRes.data ?? "balanced") as AutomationMode
  const mode: AutomationMode = ["manual", "comfort", "savings", "balanced"].includes(rawMode)
    ? rawMode
    : "balanced"
  // Mode layers over enrollment: a customer must be enrolled AND their mode
  // must permit the behavior. Manual disables all actuation.
  //   manual   — no hunting, no coasting, no precooling (still logs + measures)
  //   comfort  — hunt only, peak dodging OFF
  //   savings  — hunt below floor + peak dodging ON, widened deadband
  //   balanced — hunt + peak dodging ON, coasting bounded by the band
  const comfortAllowed = autoComfort && mode !== "manual"
  const peakAllowed = peakDodger && (mode === "savings" || mode === "balanced")

  // Build the unified model inputs (numbers may arrive as strings) + resolved
  // constraint rows. The DB is the source of truth for constraints.
  const blob = (inputsRes.data ?? null) as Record<string, unknown> | null
  const num = (v: unknown, d: number) => {
    const n = v == null ? NaN : Number(v)
    return Number.isFinite(n) ? n : d
  }
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])
  const constraintRows = (constraintsRes.error ? [] : (constraintsRes.data ?? [])) as unknown[]
  const inputs: ModelInputs = {
    met_base: num(blob?.met_base, DEFAULT_MODEL_INPUTS.met_base),
    met_adjust: num(blob?.met_adjust, 0),
    tolerance: num(blob?.tolerance, DEFAULT_MODEL_INPUTS.tolerance),
    occupants: arr(blob?.occupants).length ? arr(blob?.occupants) : DEFAULT_MODEL_INPUTS.occupants,
    health_considerations: arr(blob?.health_considerations),
    preferred_temp_f: num(blob?.preferred_temp_f ?? comfortRaw.preferred_temp_f, 72),
    preferred_rh: num(blob?.preferred_rh ?? comfortRaw.preferred_rh, 45),
    activity_level: String(blob?.activity_level ?? comfortRaw.activity_level ?? "moderate"),
    household_size: num(blob?.household_size ?? comfortRaw.household_size, 2),
    constraints: constraintRows.map((r) => coerceConstraint(r as Record<string, unknown>)),
  }

  // Safety band + tuning (hard clamp bounds).
  const minF = Number(sys?.auto_comfort_temp_min_f ?? 68)
  const maxF = Number(sys?.auto_comfort_temp_max_f ?? 78)
  const fanEnabled = !!sys?.auto_comfort_fan_enabled
  const precoolOffset = Number(sys?.peak_dodger_precool_offset_f ?? 3)
  const coastOffset = Number(sys?.peak_dodger_coast_offset_f ?? 3)

  // Nest connection (control requires it). Failures => recommendation mode.
  const token = await getNestTokenSafe()
  let thermostat: NestThermostat | null = null
  if (token) {
    try {
      thermostat = await fetchThermostat(token)
      // Refresh the HVAC-status cache so the compute pipeline can gate
      // run-state on the thermostat even while the app is closed.
      if (thermostat?.hvacStatus) await cacheHvacStatus(thermostat.hvacStatus)
    } catch (err) {
      if (err instanceof NestRateLimitError) return { ran: false, action: null, detail: "rate_limited" }
      if (err instanceof NestAuthError) thermostat = null
      else thermostat = null
    }
  }
  const nestConnected = !!token

  // Reality: Nest ambient (primary) → return-air sensor (fallback).
  const bundle = await computeLiveReading().catch(() => null)
  const sensorTemp = bundle?.computed.return_temp_f ?? null
  const sensorRh = bundle?.computed.return_rh ?? null
  const watts = bundle?.computed.total_watts ?? null

  const nestLive = !!thermostat && thermostat.ambientTempF != null && thermostat.humidity != null
  const realityTempF = nestLive ? thermostat!.ambientTempF! : sensorTemp
  const realityRh = nestLive ? thermostat!.humidity! : sensorRh

  // Two contexts: BASELINE (sleep overlay excluded) is what the displayed
  // Happy Number and the Comfort Score are measured against, so the number
  // stays comparable across the whole day. HUNT folds in the 22:00-06:00 sleep
  // overlay so the engine aims at the narrowed night band during those hours.
  const blowerOn = thermostat?.fanMode === "ON" || thermostat?.hvacStatus === "COOLING"
  const huntCtx = comfortContext({ blowerOn })
  const baseCtx = { ...huntCtx, night: false }
  const baseBand = deriveBandCached(inputs, baseCtx)
  const huntBand = huntCtx.night ? deriveBandCached(inputs, huntCtx) : baseBand

  // Always try to confirm a pending command, even if we take no new action.
  await confirmPending(db, thermostat, inputs, baseBand, baseCtx)

  if (realityTempF == null || realityRh == null) {
    return { ran: false, action: null, detail: "no reality reading" }
  }

  // Comfort Score is ALWAYS against the baseline band (comparable all day).
  const reality = scoreAgainstBand(realityTempF, realityRh, baseBand, inputs, baseCtx)
  const realityScore = reality.score
  // The displayed Happy Number is the baseline band's fingerprint.
  const targetComfort = baseBand.happyNumber
  const before: BeforeState = {
    temp_f: realityTempF,
    rh: realityRh,
    setpoint_f: thermostat?.coolSetpointF ?? null,
    comfort_score: realityScore,
    mode,
  }

  // Manual — the user runs their own system. Take no action of any kind, but
  // keep confirming pending commands (above) and log a heartbeat so evaluation
  // and savings tracking continue and honestly attribute $0 to automation.
  if (mode === "manual") {
    await maybeHeartbeat(db, "manual mode — automation off, no action taken", before)
    return { ran: false, action: null, detail: "manual mode" }
  }

  const lastAct = await lastActuationTime(db)
  const inCooldown = lastAct != null && Date.now() - lastAct < ACTUATION_COOLDOWN_MS

  const now = new Date()
  const nowMs = now.getTime()
  const parts = toCstParts(now)
  const season = seasonForMonth(parts.month)
  const isWeekday = parts.weekday >= 1 && parts.weekday <= 5
  const holiday = isRtouHoliday(parts)
  const coolingMode = thermostat?.mode === "COOL" || thermostat?.mode === "HEATCOOL"

  // ---- Automation 2: Peak Dodger (time-critical, evaluated first) ----------
  // Balanced coasts only within the band: cap the warm-side setpoint at the
  // band's upper temp edge so peak coasting can never push comfort out of band.
  // Savings coasts to the full safety limit (tolerates drift).
  const coastMaxF = mode === "balanced" ? Math.min(maxF, Math.round(huntBand.tHi)) : maxF
  if (peakAllowed && season === "summer" && isWeekday && !holiday) {
    // Pre-cool window: 2–4 PM CST (before the 4–8 PM peak).
    if (parts.hour >= 14 && parts.hour < 16) {
      if (nestConnected && coolingMode && thermostat?.coolSetpointF != null) {
        if (!inCooldown && !(await didActionToday(db, "peak_precool", nowMs))) {
          const clamp = clampSetpoint(thermostat.coolSetpointF - precoolOffset, minF, maxF)
          await applyControl(token!, { coolSetpointF: clamp.value })
          await insertJournal(db, {
            action_type: "peak_precool",
            trigger_reason: clamp.clamped
              ? `Pre-cooling before peak — held at ${clamp.value}°F safety limit`
              : `Pre-cooled to ${clamp.value}°F ahead of peak hours`,
            command_sent: { coolSetpoint: clamp.value },
            nest_confirmed: null,
            before_state: before,
            est_savings_usd: 0,
          })
          return { ran: true, action: "peak_precool" }
        }
      } else if (!nestConnected) {
        const wrote = await maybeRecommend(
          db,
          "peak_precool",
          "Pre-cool now before peak hours (4–8 PM) so your system coasts through the expensive window.",
          before,
        )
        if (wrote) return { ran: true, action: "recommendation" }
      }
    }
    // Coast window: 4–8 PM CST peak.
    else if (parts.hour >= 16 && parts.hour < 20) {
      if (nestConnected && coolingMode && thermostat?.coolSetpointF != null) {
        if (!inCooldown && !(await didActionToday(db, "peak_coast", nowMs))) {
          const clamp = clampSetpoint(thermostat.coolSetpointF + coastOffset, minF, coastMaxF)
          // Balanced: if we're already at the band's warm edge, coasting further
          // would exit the band — stop coasting rather than sacrifice comfort.
          if (mode === "balanced" && clamp.value <= Math.round(thermostat.coolSetpointF)) {
            await maybeHeartbeat(db, "balanced — holding at band edge, not coasting further", before)
            return { ran: false, action: null, detail: "balanced coast bounded by band" }
          }
          await applyControl(token!, {
            coolSetpointF: clamp.value,
            ...(fanEnabled ? { fanMode: "ON" as const } : {}),
          })
          await insertJournal(db, {
            action_type: "peak_coast",
            trigger_reason: clamp.clamped
              ? `Coasting through peak — held at ${clamp.value}°F ${mode === "balanced" ? "band edge" : "safety limit"}`
              : `Eased to ${clamp.value}°F to coast through peak hours${fanEnabled ? ", fan circulating" : ""}`,
            command_sent: { coolSetpoint: clamp.value, ...(fanEnabled ? { fan: "ON" } : {}) },
            nest_confirmed: null,
            before_state: before,
            est_savings_usd: estPeakSavingsUsd(watts, season),
          })
          return { ran: true, action: "peak_coast" }
        }
      } else if (!nestConnected) {
        const wrote = await maybeRecommend(
          db,
          "peak_coast",
          "You're in peak hours (4–8 PM). Easing your thermostat up a few degrees now will cut peak-rate cost.",
          before,
        )
        if (wrote) return { ran: true, action: "recommendation" }
      }
    }
  }

  // ---- Automation 1: Automatic Comfort Adjustment --------------------------
  // Spec §6 — hunt the GAP, two-sided. gap = comfort_score - happy_number.
  //   |gap| <= band  -> dialed in, no action
  //   gap  < -band   -> below the band: move setpoint toward the centroid
  //   gap  >  band   -> overshooting: relax toward the nearest edge, save energy
  // Spec §7 — offline: when the thermostat is down (null setpoint) we scored
  // return-duct air, not the room. Do not evaluate, do not act.
  if (comfortAllowed) {
    // §7 Offline guard. Nest connected but no setpoint = thermostat offline.
    if (nestConnected && coolingMode && thermostat?.coolSetpointF == null) {
      await maybeHeartbeat(db, "thermostat offline, cannot evaluate", before)
      return { ran: false, action: null, detail: "thermostat offline, cannot evaluate" }
    }

    const gap = realityScore - targetComfort
    // Savings widens the deadband (tolerates drift); comfort/balanced hold the
    // tight 5 + tolerance window.
    const band = 5 + huntBand.tolerance + (mode === "savings" ? SAVINGS_DRIFT_POINTS : 0)

    if (nestConnected && coolingMode && thermostat?.coolSetpointF != null) {
      const setpoint = thermostat.coolSetpointF
      if (!inCooldown && Math.abs(gap) > band) {
        // Hunt toward the HUNT band centroid (night overlay folded in 22:00-06:00).
        const targetTempF = huntBand.centroidTempF
        const targetRh = huntBand.centroidRh

        if (gap < -band) {
          // Below the band. Is humidity the dominant driver? Counterfactual
          // score gain from fixing ONLY humidity vs ONLY temperature.
          const fixTemp = scoreAgainstBand(targetTempF, realityRh, huntBand, inputs, huntCtx).score
          const fixRh = scoreAgainstBand(realityTempF, targetRh, huntBand, inputs, huntCtx).score
          const humidityDominant = fixRh - realityScore > fixTemp - realityScore

          if (humidityDominant && fanEnabled) {
            await applyControl(token!, { fanMode: "ON" })
            await insertJournal(db, {
              action_type: "fan_circulate",
              trigger_reason: "Circulating air to improve comfort (humidity was the main factor)",
              command_sent: { fan: "ON" },
              nest_confirmed: null,
              before_state: before,
              est_savings_usd: 0,
            })
            return { ran: true, action: "fan_circulate" }
          }

          // Move ONE 1°F step toward the centroid, never crossing the 68°F floor.
          const tooWarm = realityTempF > targetTempF
          const desired = tooWarm ? setpoint - COMFORT_STEP_F : setpoint + COMFORT_STEP_F
          const clamp = clampSetpoint(desired, Math.max(minF, SAFETY_FLOOR_F), maxF)
          if (clamp.value === Math.round(setpoint)) {
            await insertJournal(db, {
              action_type: "comfort_adjust",
              trigger_reason: `Holding at your ${clamp.reason === "below_min" ? Math.max(minF, SAFETY_FLOOR_F) : maxF}°F safety limit — won't push past to chase comfort`,
              command_sent: null,
              nest_confirmed: null,
              before_state: before,
              est_savings_usd: 0,
            })
            return { ran: true, action: "comfort_hold" }
          }
          await applyControl(token!, { coolSetpointF: clamp.value })
          await insertJournal(db, {
            action_type: "comfort_adjust",
            // Log before/after + the gap that triggered it (spec §6) so
            // rebuild_savings_events can measure the hunt.
            trigger_reason: `Comfort ${realityScore} vs Happy ${targetComfort} (gap ${Math.round(gap)}): setpoint ${Math.round(setpoint)}→${clamp.value}°F toward your ${Math.round(targetTempF)}°F comfort centroid`,
            command_sent: { coolSetpoint: clamp.value, hunt: { from: Math.round(setpoint), to: clamp.value, gap: Math.round(gap) } },
            nest_confirmed: null,
            before_state: before,
            est_savings_usd: 0,
          })
          return { ran: true, action: "comfort_adjust" }
        }

        // gap > band — OVERSHOOTING. We're MORE comfortable than we need to be;
        // relax toward the nearest band edge and recover energy. Savings mode
        // hunts only when comfort falls BELOW the floor (spec), so it skips this
        // proactive relax and just tolerates the drift.
        if (mode === "savings") {
          await maybeHeartbeat(db, "savings — comfort above band, tolerating drift", before)
          return { ran: false, action: null, detail: "savings drift tolerated" }
        }
        const desired = setpoint + COMFORT_STEP_F
        const clamp = clampSetpoint(desired, Math.max(minF, SAFETY_FLOOR_F), maxF)
        if (clamp.value === Math.round(setpoint)) {
          await maybeHeartbeat(db, "overshoot but at max setpoint limit", before)
          return { ran: false, action: null, detail: "overshoot, at limit" }
        }
        await applyControl(token!, { coolSetpointF: clamp.value })
        await insertJournal(db, {
          action_type: "comfort_adjust",
          trigger_reason: `Comfort ${realityScore} vs Happy ${targetComfort} (gap +${Math.round(gap)}): overshooting, easing setpoint ${Math.round(setpoint)}→${clamp.value}°F to recover energy`,
          command_sent: { coolSetpoint: clamp.value, relax: { from: Math.round(setpoint), to: clamp.value, gap: Math.round(gap) } },
          nest_confirmed: null,
          before_state: before,
          est_savings_usd: estPeakSavingsUsd(watts, season),
        })
        return { ran: true, action: "comfort_relax" }
      }
    } else if (!nestConnected && gap < -band) {
      const wrote = await maybeRecommend(
        db,
        "comfort_adjust",
        `Your home is below your comfort target. Setting your thermostat toward ${Math.round(huntBand.centroidTempF)}°F would help.`,
        before,
      )
      if (wrote) return { ran: true, action: "recommendation" }
    }
  }

  const detail = inCooldown ? "in actuation cooldown" : "comfort on track, no change needed"
  await maybeHeartbeat(db, detail, before)
  return { ran: false, action: null, detail: inCooldown ? "cooldown" : "no action needed" }
}
