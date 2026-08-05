// ---------------------------------------------------------------------------
// Server-side comfort loader. Reads the household's model inputs and resolved
// constraints from the two RPCs (comfort_model_inputs / comfort_band_constraints
// — the DB is the source of truth for constraints), then derives the band.
//
// The band is expensive (~700 PMV evals) and stable between captures, so we
// memoize it per (inputs signature + context) for a short TTL. Route handlers
// scoring many history rows call loadComfortModel ONCE and reuse the band via
// scoreAgainstBand.
// ---------------------------------------------------------------------------

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  DEFAULT_MODEL_INPUTS,
  coerceConstraint,
  deriveBand,
  type ComfortBand,
  type ComfortContext,
  type Constraint,
  type ModelInputs,
} from "./model"
import { chicagoParts } from "@/lib/chicago-time"

// Chicago wall-clock hour (0-23) for an instant — for the 22:00-06:00 sleep
// overlay. chicagoParts() intentionally exposes only date parts, so read the
// hour directly off a timezone-aware formatter here.
function chicagoHour(d: Date): number {
  const h = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "2-digit",
    hour12: false,
  }).format(d)
  const n = Number(h === "24" ? "0" : h)
  return Number.isFinite(n) ? n : 0
}

export type LoadedComfortModel = {
  inputs: ModelInputs
  band: ComfortBand
  context: ComfortContext
}

// Build the ASHRAE context from a moment + live blower state. Month drives
// clothing insulation; the 22:00-06:00 window turns on the sleep overlay; the
// blower drives indoor air speed.
export function comfortContext(opts: { at?: Date; blowerOn: boolean }): ComfortContext {
  const at = opts.at ?? new Date()
  const p = chicagoParts(at)
  const hour = chicagoHour(at)
  const night = hour >= 22 || hour < 6
  return { month: p.month - 1, blower_on: opts.blowerOn, night }
}

// Coerce the comfort_model_inputs JSON blob (numerics may arrive as strings)
// into typed ModelInputs, merging in the constraint rows.
function coerceInputs(blob: Record<string, unknown> | null, constraintRows: unknown[]): ModelInputs {
  if (!blob) {
    return {
      ...DEFAULT_MODEL_INPUTS,
      constraints: constraintRows.map((r) => coerceConstraint(r as Record<string, unknown>)),
    }
  }
  const num = (v: unknown, d: number) => {
    const n = v == null ? NaN : Number(v)
    return Number.isFinite(n) ? n : d
  }
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])

  // Constraints may come either embedded in the blob or from the dedicated RPC.
  const embedded = Array.isArray((blob as { constraints?: unknown[] }).constraints)
    ? ((blob as { constraints: unknown[] }).constraints as unknown[])
    : []
  const source = constraintRows.length > 0 ? constraintRows : embedded
  const constraints: Constraint[] = source.map((r) => coerceConstraint(r as Record<string, unknown>))

  return {
    met_base: num(blob.met_base, DEFAULT_MODEL_INPUTS.met_base),
    met_adjust: num(blob.met_adjust, 0),
    tolerance: num(blob.tolerance, DEFAULT_MODEL_INPUTS.tolerance),
    occupants: arr(blob.occupants).length ? arr(blob.occupants) : DEFAULT_MODEL_INPUTS.occupants,
    health_considerations: arr(blob.health_considerations),
    preferred_temp_f: num(blob.preferred_temp_f, DEFAULT_MODEL_INPUTS.preferred_temp_f),
    preferred_rh: num(blob.preferred_rh, DEFAULT_MODEL_INPUTS.preferred_rh),
    activity_level: String(blob.activity_level ?? DEFAULT_MODEL_INPUTS.activity_level),
    household_size: num(blob.household_size, DEFAULT_MODEL_INPUTS.household_size),
    constraints,
  }
}

// Short-lived band cache. Key = inputs signature + context. Keeps a busy route
// (scoring hundreds of history rows) from re-sweeping the PMV grid per row.
type CacheEntry = { at: number; band: ComfortBand }
const bandCache = new Map<string, CacheEntry>()
const BAND_TTL_MS = 60_000

function bandKey(inputs: ModelInputs, ctx: ComfortContext): string {
  const cs = inputs.constraints
    .map((c) => `${c.constraint_name}:${c.applies}:${c.min_temp_f},${c.max_temp_f},${c.min_rh},${c.max_rh}`)
    .sort()
    .join("|")
  // preferred_temp_f/rh are part of the key because the Happy Number is now
  // score(preferred) (spec v2.1 §3) — changing preference must bust the cache.
  return `${inputs.met_base + inputs.met_adjust}|${ctx.month}|${ctx.blower_on}|${ctx.night ? 1 : 0}|${inputs.preferred_temp_f},${inputs.preferred_rh}|${cs}`
}

export function deriveBandCached(inputs: ModelInputs, ctx: ComfortContext): ComfortBand {
  const key = bandKey(inputs, ctx)
  const hit = bandCache.get(key)
  const now = Date.now()
  if (hit && now - hit.at < BAND_TTL_MS) return hit.band
  const band = deriveBand(inputs, ctx)
  bandCache.set(key, { at: now, band })
  // Bound the cache.
  if (bandCache.size > 64) {
    for (const [k, v] of bandCache) if (now - v.at >= BAND_TTL_MS) bandCache.delete(k)
  }
  return band
}

// Load the household model inputs + constraints and derive the band for a
// context. This is THE entry point for every server consumer.
export async function loadComfortModel(
  supabase: SupabaseClient,
  siteId: string,
  ctx: ComfortContext,
): Promise<LoadedComfortModel> {
  const [inputsRes, constraintsRes] = await Promise.all([
    supabase.rpc("comfort_model_inputs", { p_site_id: siteId }),
    supabase.rpc("comfort_band_constraints", { p_site_id: siteId }),
  ])

  const blob = (inputsRes.data ?? null) as Record<string, unknown> | null
  const rows = (constraintsRes.error ? [] : (constraintsRes.data ?? [])) as unknown[]
  const inputs = coerceInputs(blob, rows)
  const band = deriveBandCached(inputs, ctx)
  return { inputs, band, context: ctx }
}
