// =====================================================================
// Fan (blower) schedule.
//
//   auto  fan runs only with heating/cooling (Nest's own behavior)
//   on    always on — Google only allows a fan timer of up to 12 hours, so
//         the app starts a 12-hour timer and renews it before it runs out
//   30    runs 30 minutes at the top of every hour
//   15    runs 15 minutes at the top of every hour
//
// There is no true "fan off": the furnace and AC always run the blower while
// they're heating or cooling. If the app or internet goes down, the fan just
// finishes its current timer (12 hours at most) and goes back to auto.
//
// Called from the 5-minute automation tick. It only talks to the Nest when it
// actually has something to do, so it doesn't eat into Google's rate limit.
// =====================================================================

import type { SupabaseClient } from "@supabase/supabase-js"
import { SITE_ID } from "@/lib/compute-reading"
import { applyControl, getFreshAccessToken, MAX_FAN_MINUTES } from "@/lib/nest/client"

export const FAN_SCHEDULES = ["auto", "on", "30", "15"] as const
export type FanSchedule = (typeof FAN_SCHEDULES)[number]

// The tick runs every 5 minutes; hourly runs start in the first tick of the hour.
const TICK_WINDOW_MIN = 5
// Renew the always-on timer once it has run this long (well before 12 h).
const RENEW_AFTER_MS = 11 * 3600_000

export function isFanSchedule(v: unknown): v is FanSchedule {
  return typeof v === "string" && (FAN_SCHEDULES as readonly string[]).includes(v)
}

// What the schedule wants to do right now, if anything (pure — easy to test).
export function fanScheduleAction(
  schedule: FanSchedule,
  lastStart: Date | null,
  now: Date,
): { minutes: number } | null {
  if (schedule === "auto") return null
  if (schedule === "on") {
    if (lastStart && now.getTime() - lastStart.getTime() < RENEW_AFTER_MS) return null
    return { minutes: MAX_FAN_MINUTES }
  }
  const minutes = Number(schedule)
  const hourStart = new Date(now)
  hourStart.setUTCMinutes(0, 0, 0)
  if (lastStart && lastStart.getTime() >= hourStart.getTime()) return null // already ran this hour
  if (now.getUTCMinutes() >= TICK_WINDOW_MIN) return null // wait for the top of the next hour
  return { minutes }
}

export async function runFanSchedule(db: SupabaseClient): Promise<{ action: string | null; detail: string }> {
  const { data: sys } = await db
    .from("system_profile")
    .select("fan_schedule, fan_schedule_last_start")
    .eq("site_id", SITE_ID)
    .maybeSingle()
  const schedule: FanSchedule = isFanSchedule(sys?.fan_schedule) ? sys!.fan_schedule : "auto"
  const lastStart = sys?.fan_schedule_last_start ? new Date(sys.fan_schedule_last_start) : null
  const now = new Date()
  const act = fanScheduleAction(schedule, lastStart, now)
  if (!act) return { action: null, detail: `fan ${schedule}: nothing to do` }

  const token = await getFreshAccessToken().catch(() => null)
  if (!token) return { action: null, detail: "fan schedule: Nest not connected" }
  await applyControl(token, { fanMode: "ON", fanMinutes: act.minutes })
  await db
    .from("system_profile")
    .update({ fan_schedule_last_start: now.toISOString() })
    .eq("site_id", SITE_ID)
  return { action: "fan_on", detail: `fan ${schedule}: started ${act.minutes} min` }
}
