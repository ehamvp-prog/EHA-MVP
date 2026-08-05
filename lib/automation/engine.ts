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
import {
  scoreAgainstBand,
  selectTarget,
  type ComfortBand,
  type ModelInputs,
  coerceConstraint,
  DEFAULT_MODEL_INPUTS,
} from "@/lib/comfort/model"
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
//
// Comfort control (spec v2.1): the loop drives live conditions to the household's
// PREFERRED conditions — clamped only by health-derived limits — using a
// temperature/RH ERROR, never the Comfort/Happy score gap (the score is unimodal
// and carries no direction, so it can't drive a target). The setpoint is
// direct-set to the target, not stepped. Relaxing the setpoint away from target
// is NOT a default; it fires only inside a sanctioned peak/precool window (§7).
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
// Two-tier floor (spec v2.3 §6.4). Every downward command from every automation
// clamps against the MORE restrictive of:
//   - comfort minimum (`comfort_profile.min_comfort_temp_f`): the coldest the
//     HOUSEHOLD is willing to be. Defaults to sleep_target − 2.
//   - equipment floor (`system_profile.installer_min_f`): coil/compressor
//     protection, set by the installer. Defaults to 62°F.
// These now come from the DB; the constants below are only fallbacks for a row
// that predates the migration. The old hard-coded 68°F floor is GONE.
const COMFORT_MIN_FALLBACK_F = 64
const EQUIPMENT_FLOOR_FALLBACK_F = 62
// Re-send only when the standing setpoint differs from the command by more than
// this (spec §6.3). Direct-set — we command the target, we do NOT step toward it.
const RESEND_THRESHOLD_F = 1
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

// Start time (ms) of the CURRENT unbroken overcool streak, or null if the most
// recent comfort actuation was not an overcool (i.e. overcool was released).
// Used for the 90-minute overcool guard (spec v2.3 §6.2.1 / §6.2.3).
async function overcoolStreakStartMs(db: Db, nowMs: number): Promise<number | null> {
  const since = new Date(nowMs - 3 * 60 * 60 * 1000).toISOString()
  const { data } = await db
    .from("automation_journal")
    .select("occurred_at, command_sent")
    .eq("site_id", SITE_ID)
    .eq("action_type", "comfort_adjust")
    .not("command_sent", "is", null)
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: false })
    .limit(40)
  if (!data?.length) return null
  let streakStart: number | null = null
  for (const r of data) {
    const isOvercool = !!(r.command_sent as { overcool?: boolean } | null)?.overcool
    if (!isOvercool) break // streak broken → overcool was released
    streakStart = new Date(r.occurred_at).getTime()
  }
  return streakStart
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

  // Safety band + tuning. installerMax is the upper hard clamp. The LOWER clamp
  // for every downward command is `comfortFloor` (spec v2.3 §6.4) — the more
  // restrictive of the household comfort minimum and the equipment floor. The
  // old `auto_comfort_temp_min_f` (68) no longer gates downward commands; it
  // would silently block a legitimate 66°F setpoint.
  const installerMax = Number(sys?.auto_comfort_temp_max_f ?? 78)
  const comfortMinF = Number(comfortRaw.min_comfort_temp_f ?? COMFORT_MIN_FALLBACK_F)
  const equipmentFloorF = Number(sys?.installer_min_f ?? EQUIPMENT_FLOOR_FALLBACK_F)
  const comfortFloor = Math.max(comfortMinF, equipmentFloorF)
  const fanEnabled = !!sys?.auto_comfort_fan_enabled
  const precoolOffset = Number(sys?.peak_dodger_precool_offset_f ?? 3)
  const coastOffset = Number(sys?.peak_dodger_coast_offset_f ?? 3)

  // Sleep schedule (spec v2.3 §8). Window comes from the profile and is judged
  // per-tick against Chicago wall-clock (handled in comfortContext); the target
  // defaults to the PREFERRED temperature (§8.2), never preferred − 2.
  const sleepEnabled = comfortRaw.sleep_enabled !== false
  const sleepStart = String(comfortRaw.sleep_start ?? "22:00").slice(0, 5)
  const sleepEnd = String(comfortRaw.sleep_end ?? "06:00").slice(0, 5)
  const sleepTargetF = Number(comfortRaw.sleep_target_f ?? comfortRaw.preferred_temp_f ?? 68)

  // Humidity capability (spec v2.3 §6.2.1).
  const hasDehumidifier = !!sys?.has_dehumidifier
  const overcoolLimitF = Number(sys?.overcool_limit_f ?? 2)

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
  const huntCtx = comfortContext({
    blowerOn,
    sleep: sleepEnabled ? { start: sleepStart, end: sleepEnd } : null,
  })
  const baseCtx = { ...huntCtx, night: false }
  const baseBand = deriveBandCached(inputs, baseCtx)
  // Inside the sleep window the household's effective target is sleep_target_f,
  // so the hunt band (and therefore its Happy Number) is recomputed AT the sleep
  // target (spec v2.3 §8.2) — the comparison and the drive-to stay consistent.
  const inSleep = huntCtx.night
  const huntInputs: ModelInputs = inSleep ? { ...inputs, preferred_temp_f: sleepTargetF } : inputs
  const huntBand = inSleep ? deriveBandCached(huntInputs, huntCtx) : baseBand

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
  const coastMaxF = mode === "balanced" ? Math.min(installerMax, Math.round(huntBand.tHi)) : installerMax
  if (peakAllowed && season === "summer" && isWeekday && !holiday) {
    // Pre-cool window: 2–4 PM CST (before the 4–8 PM peak).
    if (parts.hour >= 14 && parts.hour < 16) {
      if (nestConnected && coolingMode && thermostat?.coolSetpointF != null) {
        if (!inCooldown && !(await didActionToday(db, "peak_precool", nowMs))) {
          // §8.2a: precool clamps to the SAME comfort_floor as everything else —
          // no separate hardcoded floor in the peak path.
          const clamp = clampSetpoint(thermostat.coolSetpointF - precoolOffset, comfortFloor, installerMax)
          await applyControl(token!, { coolSetpointF: clamp.value })
          await insertJournal(db, {
            action_type: "peak_precool",
            trigger_reason: clamp.clamped
              ? `Pre-cooling before peak — held at your ${clamp.value}°F comfort floor`
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
          const clamp = clampSetpoint(thermostat.coolSetpointF + coastOffset, comfortFloor, coastMaxF)
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
  // Spec v2.3 §6.1 — TWO questions answered by TWO quantities:
  //   Is something wrong?  gap = comfort_score - happy_number, |gap| > tolerance
  //   Where do we go?      target = clamp(preferred | sleep_target, slice)
  // The gap never supplies DIRECTION (it's a distance between two scores); the
  // sign is not a mode and a score above happy is the same miss as below. We
  // additionally trigger on |temp_error| so a near-typical household whose gap
  // compresses under tolerance can never be stranded off its target.
  if (comfortAllowed) {
    // §7 offline guard: Nest connected but no setpoint = thermostat offline.
    if (nestConnected && coolingMode && thermostat?.coolSetpointF == null) {
      await maybeHeartbeat(db, "thermostat offline, cannot evaluate", before)
      return { ran: false, action: null, detail: "thermostat offline, cannot evaluate" }
    }

    // Decide against the HUNT band/inputs so the sleep target and its recomputed
    // Happy Number apply inside the window (§8.2).
    const huntScore = scoreAgainstBand(realityTempF, realityRh, huntBand, huntInputs, huntCtx).score
    const gap = huntScore - huntBand.happyNumber
    const tolerance = (inSleep ? 3 : 5) + (mode === "savings" ? 3 : 0)

    const sel = selectTarget(huntBand, huntInputs, realityRh)
    const targetTempF = sel.targetTempF
    const targetRh = sel.targetRh
    const tempError = realityTempF - targetTempF // >0 too warm
    const deadbandF = 1 + (mode === "savings" ? 1 : 0)
    const offNumber = Math.abs(gap) > tolerance || Math.abs(tempError) > deadbandF

    // §6.2 dominant factor — which axis is further off ITS target, measured as
    // physical error on a common scale (°F vs %RH normalized by their comfort
    // half-widths ~3°F / ~10%RH). NOTE: we must NOT use scoreAgainstBand here —
    // under the §3.2 curve that score is MINIMIZED at target and rises with
    // distance toward the typical reference, so a "recovery toward target" reads
    // as negative. Distance-from-target is the correct, curve-independent signal.
    const tempOff = Math.abs(tempError) / 3
    const rhOff = Math.abs(realityRh - targetRh) / 10
    // Humidity only "wins" when it is the larger deficit AND the room is actually
    // too humid (over-dry is not something cooling/overcool can fix).
    const humidityDominant = rhOff > tempOff && realityRh > targetRh
    const dominantFactor = humidityDominant ? "humidity" : "temperature"

    // §6.5 journal payload — the same fields every tick so a wrong target is
    // visible immediately.
    const decisionLog = {
      target: Math.round(targetTempF),
      target_rh: Math.round(targetRh),
      happy_number: huntBand.happyNumber,
      comfort_score: huntScore,
      gap: Math.round(gap),
      dominant_factor: dominantFactor,
      temp_error: Math.round(tempError),
      binding_constraint: sel.tempClampedBy ?? sel.rhClampedBy ?? null,
      sleep: inSleep,
    }

    if (nestConnected && coolingMode && thermostat?.coolSetpointF != null) {
      const setpoint = thermostat.coolSetpointF

      if (!inCooldown && offNumber) {
        // ---- Humidity is the dominant deficit (§6.2.1) --------------------
        if (humidityDominant) {
          if (hasDehumidifier) {
            // Dedicated dehumidifier: run it, setpoint untouched. (No Nest
            // actuator for this in the current integration — journal the intent.)
            await insertJournal(db, {
              action_type: "comfort_adjust",
              trigger_reason: `Humidity ${Math.round(realityRh)}% over your ${Math.round(targetRh)}% target — running dehumidifier, setpoint held at ${Math.round(setpoint)}°F.`,
              command_sent: { dehumidify: true, ...decisionLog },
              nest_confirmed: null,
              before_state: before,
              est_savings_usd: 0,
            })
            return { ran: true, action: "comfort_adjust" }
          }

          // No dehumidifier: the only latent lever is longer compressor cycles,
          // achieved by overcooling below target, bounded by overcool_limit_f
          // and the comfort floor. 90-minute guard: if overcool has run that
          // long without hitting target RH, the problem is airflow/charge/
          // envelope — stop and raise a service diagnostic (§6.2.3).
          const overcoolStart = await overcoolStreakStartMs(db, nowMs)
          if (overcoolStart != null && nowMs - overcoolStart >= 90 * 60_000) {
            const wrote = await maybeRecommend(
              db,
              "comfort_adjust",
              `Humidity has stayed above target for over 90 minutes of overcooling. This points to airflow, refrigerant charge, or envelope — worth a technician review.`,
              before,
            )
            return wrote ? { ran: true, action: "recommendation" } : { ran: false, action: null, detail: "overcool diagnostic pending" }
          }

          const rhExcess = realityRh - targetRh
          const overcool = Math.min(overcoolLimitF, rhExcess / 5)
          const clamp = clampSetpoint(targetTempF - overcool, comfortFloor, installerMax)
          if (Math.abs(clamp.value - setpoint) <= RESEND_THRESHOLD_F) {
            await maybeHeartbeat(db, `overcooling to ${clamp.value}°F for humidity, already there`, before)
            return { ran: false, action: null, detail: "overcool already applied" }
          }
          await applyControl(token!, { coolSetpointF: clamp.value })
          await insertJournal(db, {
            action_type: "comfort_adjust",
            trigger_reason: clamp.clamped
              ? `Humidity ${Math.round(realityRh)}% over ${Math.round(targetRh)}% — would overcool further but holding at your ${clamp.value}°F comfort floor.`
              : `Humidity ${Math.round(realityRh)}% over ${Math.round(targetRh)}% — overcooling to ${clamp.value}°F to pull moisture down (target ${Math.round(targetTempF)}°F).`,
            command_sent: { coolSetpoint: clamp.value, overcool: true, ...decisionLog },
            nest_confirmed: null,
            before_state: before,
            est_savings_usd: 0,
          })
          return { ran: true, action: "comfort_adjust" }
        }

        // ---- Temperature is dominant: direct-set the target (§6.3) ---------
        const clamp = clampSetpoint(targetTempF, comfortFloor, installerMax)
        if (Math.abs(clamp.value - setpoint) <= RESEND_THRESHOLD_F) {
          await maybeHeartbeat(db, `already at ${clamp.value}°F target, no re-send`, before)
          return { ran: false, action: null, detail: "already at target" }
        }
        const clampNote = clamp.clamped
          ? ` — holding at your ${clamp.value}°F ${comfortFloor === comfortMinF ? "comfort minimum" : "equipment floor"}`
          : ""
        await applyControl(token!, { coolSetpointF: clamp.value })
        await insertJournal(db, {
          action_type: "comfort_adjust",
          trigger_reason: `Indoor ${Math.round(realityTempF)}°F vs your ${Math.round(targetTempF)}°F ${inSleep ? "sleep " : ""}target (gap ${Math.round(gap)}, error ${tempError > 0 ? "+" : ""}${Math.round(tempError)}): setpoint ${Math.round(setpoint)}→${clamp.value}°F${clampNote}. Comfort ${realityScore}, Happy ${targetComfort}.`,
          command_sent: { coolSetpoint: clamp.value, ...decisionLog },
          nest_confirmed: null,
          before_state: before,
          est_savings_usd: 0,
        })
        return { ran: true, action: "comfort_adjust" }
      }

      // On the number (or in cooldown). Conditions at/better than target are a
      // SUCCESS — we never relax here; that only happens in a sanctioned peak
      // window (§7). This is what prevents the overnight walk-up.
      if (!offNumber) {
        await maybeHeartbeat(db, `at your ${Math.round(targetTempF)}°F target (gap ${Math.round(gap)}) — dialed in`, before)
        return { ran: false, action: null, detail: "dialed in" }
      }
    } else if (!nestConnected && offNumber) {
      const wrote = await maybeRecommend(
        db,
        "comfort_adjust",
        `Your home is off your comfort target. Setting your thermostat toward ${Math.round(targetTempF)}°F would help.`,
        before,
      )
      if (wrote) return { ran: true, action: "recommendation" }
    }
  }

  const detail = inCooldown ? "in actuation cooldown" : "comfort on track, no change needed"
  await maybeHeartbeat(db, detail, before)
  return { ran: false, action: null, detail: inCooldown ? "cooldown" : "no action needed" }
}
