import "server-only"
import { createAdminClient } from "@/lib/supabase/admin"
import type { HvacStatus } from "@/lib/engine/system-state"

// ---------------------------------------------------------------------------
// Google Nest SDM (Smart Device Management) integration — DISPLAY & CONTROL
// ONLY. Nest data never feeds computed_readings, the SEER calc, or the cost
// engine. All Google API calls happen server-side; the browser never sees a
// token or talks to the SDM API directly.
// ---------------------------------------------------------------------------

const SITE_ID = "default"

const GOOGLE_AUTH_URL = "https://nestservices.google.com/partnerconnections"
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
const SDM_BASE = "https://smartdevicemanagement.googleapis.com/v1"
// SDM requires this exact scope for thermostat read + control.
export const SDM_SCOPE = "https://www.googleapis.com/auth/sdm.service"

export function getNestConfig() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  const projectId = process.env.NEST_PROJECT_ID
  return { clientId, clientSecret, projectId }
}

export function nestConfigured(): boolean {
  const { clientId, clientSecret, projectId } = getNestConfig()
  return Boolean(clientId && clientSecret && projectId)
}

// Resolve the public origin for OAuth redirects. Prefer an explicit site URL,
// fall back to the Vercel deployment URL, then localhost for dev.
export function resolveOrigin(reqUrl?: string): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL || process.env.NEST_REDIRECT_ORIGIN
  if (explicit) return explicit.replace(/\/$/, "")
  if (reqUrl) {
    try {
      return new URL(reqUrl).origin
    } catch {
      /* ignore */
    }
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  return "http://localhost:3000"
}

export function redirectUri(origin: string): string {
  return `${origin}/api/nest/callback`
}

// Build the Google Partner Connections authorization URL.
export function buildAuthUrl(origin: string): string {
  const { clientId, projectId } = getNestConfig()
  const params = new URLSearchParams({
    client_id: clientId ?? "",
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: SDM_SCOPE,
    access_type: "offline",
    prompt: "consent",
  })
  // Device Access partner connection URL is namespaced by the project id.
  return `${GOOGLE_AUTH_URL}/${projectId}/auth?${params.toString()}`
}

type TokenRow = {
  access_token: string | null
  refresh_token: string | null
  expires_at: string | null
}

export async function getTokenRow(): Promise<TokenRow | null> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from("nest_tokens")
    .select("access_token, refresh_token, expires_at")
    .eq("site_id", SITE_ID)
    .maybeSingle()
  if (error) throw error
  return data ?? null
}

export async function hasNestConnection(): Promise<boolean> {
  const row = await getTokenRow()
  return Boolean(row?.refresh_token)
}

// Persist the last-seen HVAC status so the compute pipeline can read the
// thermostat's on/off mode without making its own SDM API call. Best-effort.
export async function cacheHvacStatus(status: HvacStatus): Promise<void> {
  if (!status) return
  try {
    const supabase = createAdminClient()
    await supabase
      .from("nest_tokens")
      .update({ last_hvac_status: status, last_hvac_at: new Date().toISOString() })
      .eq("site_id", SITE_ID)
  } catch {
    /* non-fatal: caching is an optimization, not a requirement */
  }
}

// Read the cached HVAC status if it is fresh enough to trust. Returns null
// when there is no thermostat, no cache, or the cache is stale — in which
// case run-state falls back to pure sensor inference.
export async function getCachedHvacStatus(maxAgeMs = 10 * 60 * 1000): Promise<HvacStatus> {
  try {
    const supabase = createAdminClient()
    const { data } = await supabase
      .from("nest_tokens")
      .select("last_hvac_status, last_hvac_at")
      .eq("site_id", SITE_ID)
      .maybeSingle()
    const status = (data as { last_hvac_status?: string | null } | null)?.last_hvac_status ?? null
    const at = (data as { last_hvac_at?: string | null } | null)?.last_hvac_at ?? null
    if (!status || !at) return null
    if (Date.now() - new Date(at).getTime() > maxAgeMs) return null
    return status as HvacStatus
  } catch {
    return null
  }
}

// Exchange an authorization code for tokens and persist them.
export async function exchangeCodeForTokens(code: string, origin: string): Promise<void> {
  const { clientId, clientSecret } = getNestConfig()
  const body = new URLSearchParams({
    client_id: clientId ?? "",
    client_secret: clientSecret ?? "",
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri(origin),
  })
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Token exchange failed (${res.status}): ${text}`)
  }
  const json = (await res.json()) as {
    access_token: string
    refresh_token?: string
    expires_in: number
  }
  const expiresAt = new Date(Date.now() + json.expires_in * 1000).toISOString()
  const supabase = createAdminClient()
  const { error } = await supabase.from("nest_tokens").upsert(
    {
      site_id: SITE_ID,
      access_token: json.access_token,
      // Google only returns refresh_token on first consent; keep it if absent.
      ...(json.refresh_token ? { refresh_token: json.refresh_token } : {}),
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "site_id" },
  )
  if (error) throw error
}

// Return a valid access token, refreshing via the stored refresh token when
// the cached one is missing or within 60s of expiry.
export async function getFreshAccessToken(): Promise<string | null> {
  const row = await getTokenRow()
  if (!row?.refresh_token) return null

  const notExpired =
    row.access_token && row.expires_at && new Date(row.expires_at).getTime() - 60_000 > Date.now()
  if (notExpired && row.access_token) return row.access_token

  const { clientId, clientSecret } = getNestConfig()
  const body = new URLSearchParams({
    client_id: clientId ?? "",
    client_secret: clientSecret ?? "",
    refresh_token: row.refresh_token,
    grant_type: "refresh_token",
  })
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  })
  if (!res.ok) {
    // 400/401 here usually means the refresh token was revoked.
    if (res.status === 400 || res.status === 401) {
      throw new NestAuthError("Nest refresh token is invalid or revoked")
    }
    const text = await res.text()
    throw new Error(`Token refresh failed (${res.status}): ${text}`)
  }
  const json = (await res.json()) as { access_token: string; expires_in: number }
  const expiresAt = new Date(Date.now() + json.expires_in * 1000).toISOString()
  const supabase = createAdminClient()
  await supabase
    .from("nest_tokens")
    .update({ access_token: json.access_token, expires_at: expiresAt, updated_at: new Date().toISOString() })
    .eq("site_id", SITE_ID)
  return json.access_token
}

// Clear the stored token (used by Reconnect when the token is dead).
export async function clearTokens(): Promise<void> {
  const supabase = createAdminClient()
  await supabase.from("nest_tokens").delete().eq("site_id", SITE_ID)
}

export class NestAuthError extends Error {}
export class NestRateLimitError extends Error {}

// Low-level SDM fetch with one-shot exponential backoff on 429.
async function sdmFetch(path: string, accessToken: string, init?: RequestInit, attempt = 0): Promise<Response> {
  const res = await fetch(`${SDM_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  })
  if (res.status === 429 && attempt < 3) {
    const retryAfter = Number(res.headers.get("retry-after"))
    const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000
    await new Promise((r) => setTimeout(r, delay))
    return sdmFetch(path, accessToken, init, attempt + 1)
  }
  if (res.status === 429) throw new NestRateLimitError("Nest API rate limit exceeded")
  if (res.status === 401) throw new NestAuthError("Nest access token rejected")
  return res
}

const cToF = (c: number) => Math.round((c * 9) / 5 + 32)
const fToC = (f: number) => ((f - 32) * 5) / 9

export type NestThermostat = {
  deviceName: string // full SDM resource name, used for control commands
  ambientTempF: number | null
  humidity: number | null
  mode: "HEAT" | "COOL" | "HEATCOOL" | "OFF" | null
  hvacStatus: "HEATING" | "COOLING" | "OFF" | null
  heatSetpointF: number | null
  coolSetpointF: number | null
  fanMode: "ON" | "OFF" | null
  fanTimeout: string | null
}

// Find the first thermostat device and read its traits.
export async function fetchThermostat(accessToken: string): Promise<NestThermostat | null> {
  const { projectId } = getNestConfig()
  const res = await sdmFetch(`/enterprises/${projectId}/devices`, accessToken)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`SDM devices read failed (${res.status}): ${text}`)
  }
  const json = (await res.json()) as { devices?: NestDevice[] }
  const device = (json.devices ?? []).find((d) => d.type === "sdm.devices.types.THERMOSTAT")
  if (!device) return null

  const t = device.traits ?? {}
  const ambientC = t["sdm.devices.traits.Temperature"]?.ambientTemperatureCelsius
  const humidity = t["sdm.devices.traits.Humidity"]?.ambientHumidityPercent
  const mode = t["sdm.devices.traits.ThermostatMode"]?.mode ?? null
  const hvac = t["sdm.devices.traits.ThermostatHvac"]?.status ?? null
  const sp = t["sdm.devices.traits.ThermostatTemperatureSetpoint"] ?? {}
  const fan = t["sdm.devices.traits.Fan"] ?? {}

  return {
    deviceName: device.name,
    ambientTempF: ambientC != null ? cToF(ambientC) : null,
    humidity: humidity != null ? Math.round(humidity) : null,
    mode: mode as NestThermostat["mode"],
    hvacStatus: hvac as NestThermostat["hvacStatus"],
    heatSetpointF: sp.heatCelsius != null ? cToF(sp.heatCelsius) : null,
    coolSetpointF: sp.coolCelsius != null ? cToF(sp.coolCelsius) : null,
    fanMode: (fan.timerMode as "ON" | "OFF") ?? null,
    fanTimeout: fan.timerTimeout ?? null,
  }
}

// Issue an SDM command to a device.
async function executeCommand(
  accessToken: string,
  deviceName: string,
  command: string,
  params: Record<string, unknown>,
): Promise<void> {
  const res = await sdmFetch(`/${deviceName}:executeCommand`, accessToken, {
    method: "POST",
    body: JSON.stringify({ command, params }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`SDM command ${command} failed (${res.status}): ${text}`)
  }
}

export type ControlInput = {
  mode?: "HEAT" | "COOL" | "HEATCOOL" | "OFF"
  heatSetpointF?: number
  coolSetpointF?: number
  fanMode?: "ON" | "AUTO"
}

// Apply a control change to the thermostat. Order matters: set the mode first
// so setpoint commands are valid for the active mode.
export async function applyControl(accessToken: string, input: ControlInput): Promise<void> {
  const thermostat = await fetchThermostat(accessToken)
  if (!thermostat) throw new Error("No Nest thermostat found")
  const device = thermostat.deviceName

  if (input.mode) {
    await executeCommand(accessToken, device, "sdm.devices.commands.ThermostatMode.SetMode", {
      mode: input.mode,
    })
  }

  const effectiveMode = input.mode ?? thermostat.mode

  if (effectiveMode === "HEATCOOL" && input.heatSetpointF != null && input.coolSetpointF != null) {
    await executeCommand(
      accessToken,
      device,
      "sdm.devices.commands.ThermostatTemperatureSetpoint.SetRange",
      { heatCelsius: fToC(input.heatSetpointF), coolCelsius: fToC(input.coolSetpointF) },
    )
  } else if (effectiveMode === "HEAT" && input.heatSetpointF != null) {
    await executeCommand(
      accessToken,
      device,
      "sdm.devices.commands.ThermostatTemperatureSetpoint.SetHeat",
      { heatCelsius: fToC(input.heatSetpointF) },
    )
  } else if (effectiveMode === "COOL" && input.coolSetpointF != null) {
    await executeCommand(
      accessToken,
      device,
      "sdm.devices.commands.ThermostatTemperatureSetpoint.SetCool",
      { coolCelsius: fToC(input.coolSetpointF) },
    )
  }

  if (input.fanMode) {
    // AUTO turns the timer off; ON runs the fan on a standard 1h timer.
    if (input.fanMode === "AUTO") {
      await executeCommand(accessToken, device, "sdm.devices.commands.Fan.SetTimer", {
        timerMode: "OFF",
      })
    } else {
      await executeCommand(accessToken, device, "sdm.devices.commands.Fan.SetTimer", {
        timerMode: "ON",
        duration: "3600s",
      })
    }
  }
}

// ---- SDM device/trait typing ----------------------------------------------
type NestDevice = {
  name: string
  type: string
  traits?: {
    "sdm.devices.traits.Temperature"?: { ambientTemperatureCelsius?: number }
    "sdm.devices.traits.Humidity"?: { ambientHumidityPercent?: number }
    "sdm.devices.traits.ThermostatMode"?: { mode?: string }
    "sdm.devices.traits.ThermostatHvac"?: { status?: string }
    "sdm.devices.traits.ThermostatTemperatureSetpoint"?: { heatCelsius?: number; coolCelsius?: number }
    "sdm.devices.traits.Fan"?: { timerMode?: string; timerTimeout?: string }
  }
}
