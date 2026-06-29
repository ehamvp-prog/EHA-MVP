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
import {
  comfortDetail,
  comfortFromConditions,
  clampSetpoint,
  monthCst,
} from "@/lib/comfort/ring"
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

// Comfort must be at least this far below target before we actuate.
const COMFORT_TRIGGER_GAP = 8
// Don't repeat the same recommendation more than once per hour.
const RECO_COOLDOWN_MS = 60 * 60 * 1000
// Heartbeat: when a tick takes no action, log an "evaluation" row at most this
// often, so the journal proves the engine is running without flooding it
// (a row every 5-min tick would be 288/day; this caps it to ~48/day).
const HEARTBEAT_MS = 30 * 60 * 1000
// Single comfort nudge step (°F).
const COMFORT_STEP_F = 2
// Confirmation tolerance — SDM rounds to ~0.5°C, so allow ~1°F slack.
const CONFIRM_TOLERANCE_F = 1

export type TickResult = { ran: boolean; action: string | null; detail?: string }

type ComfortRow = {
  preferred_temp_f: number
  preferred_rh: number
  activity_level: "sedentary" | "moderate" | "active"
}

type BeforeState = {
  temp_f: number
  rh: number
  setpoint_f: number | null
  comfort_score: number
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
  comfort: ComfortRow,
  month: number,
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
      ? comfortDetail(thermostat.ambientTempF, thermostat.humidity, comfort, month).comfort
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

  const [{ data: sys }, { data: comfortRaw }] = await Promise.all([
    db.from("system_profile").select("*").eq("site_id", SITE_ID).maybeSingle(),
    db.from("comfort_profile").select("*").eq("site_id", SITE_ID).maybeSingle(),
  ])

  const autoComfort = !!sys?.auto_comfort_enabled
  const peakDodger = !!sys?.peak_dodger_enabled
  if (!autoComfort && !peakDodger) return { ran: false, action: null, detail: "no automations enabled" }
  if (!comfortRaw) return { ran: false, action: null, detail: "no comfort profile" }

  const comfort: ComfortRow = {
    preferred_temp_f: Number(comfortRaw.preferred_temp_f ?? 72),
    preferred_rh: Number(comfortRaw.preferred_rh ?? 45),
    activity_level: (comfortRaw.activity_level as ComfortRow["activity_level"]) ?? "moderate",
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

  // Always try to confirm a pending command, even if we take no new action.
  const month = monthCst()
  await confirmPending(db, thermostat, comfort, month)

  if (realityTempF == null || realityRh == null) {
    return { ran: false, action: null, detail: "no reality reading" }
  }

  const realityDetail = comfortDetail(realityTempF, realityRh, comfort, month)
  const targetComfort = comfortFromConditions(comfort.preferred_temp_f, comfort.preferred_rh, comfort, month)
  const before: BeforeState = {
    temp_f: realityTempF,
    rh: realityRh,
    setpoint_f: thermostat?.coolSetpointF ?? null,
    comfort_score: realityDetail.comfort,
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
  if (peakDodger && season === "summer" && isWeekday && !holiday) {
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
          const clamp = clampSetpoint(thermostat.coolSetpointF + coastOffset, minF, maxF)
          await applyControl(token!, {
            coolSetpointF: clamp.value,
            ...(fanEnabled ? { fanMode: "ON" as const } : {}),
          })
          await insertJournal(db, {
            action_type: "peak_coast",
            trigger_reason: clamp.clamped
              ? `Coasting through peak — held at ${clamp.value}°F safety limit`
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
  if (autoComfort && realityDetail.comfort <= targetComfort - COMFORT_TRIGGER_GAP) {
    if (nestConnected && coolingMode && thermostat?.coolSetpointF != null) {
      if (!inCooldown) {
        // Is humidity the dominant driver? (counterfactual comfort gain)
        const fixTemp = comfortFromConditions(comfort.preferred_temp_f, realityRh, comfort, month)
        const fixRh = comfortFromConditions(realityTempF, comfort.preferred_rh, comfort, month)
        const humidityDominant = fixRh - realityDetail.comfort > fixTemp - realityDetail.comfort

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

        // PMV>0 = too warm → lower cool setpoint; PMV<0 = too cool → raise.
        const tooWarm = realityDetail.pmv > 0
        const desired = tooWarm
          ? thermostat.coolSetpointF - COMFORT_STEP_F
          : thermostat.coolSetpointF + COMFORT_STEP_F
        const clamp = clampSetpoint(desired, minF, maxF)

        // Refuse to cross the band: if the clamp leaves the setpoint unchanged,
        // log that we're holding at the safety limit and send NO command.
        if (clamp.value === Math.round(thermostat.coolSetpointF)) {
          await insertJournal(db, {
            action_type: "comfort_adjust",
            trigger_reason: `Holding at your ${clamp.reason === "below_min" ? minF : maxF}°F safety limit — won't push past the band to chase comfort`,
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
          trigger_reason: clamp.clamped
            ? `Adjusting toward comfort — clamped to ${clamp.value}°F safety limit`
            : `Set thermostat to ${clamp.value}°F to bring comfort toward your target`,
          command_sent: { coolSetpoint: clamp.value },
          nest_confirmed: null,
          before_state: before,
          est_savings_usd: 0,
        })
        return { ran: true, action: "comfort_adjust" }
      }
    } else if (!nestConnected) {
      const wrote = await maybeRecommend(
        db,
        "comfort_adjust",
        `Your home is below your comfort target. Setting your thermostat toward ${Math.round(comfort.preferred_temp_f)}°F would help.`,
        before,
      )
      if (wrote) return { ran: true, action: "recommendation" }
    }
  }

  const detail = inCooldown ? "in actuation cooldown" : "comfort on track, no change needed"
  await maybeHeartbeat(db, detail, before)
  return { ran: false, action: null, detail: inCooldown ? "cooldown" : "no action needed" }
}
