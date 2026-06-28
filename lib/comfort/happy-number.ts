// ---------------------------------------------------------------------------
// Live Happy Number — ASHRAE Standard 55 / ISO 7730 Fanger PMV/PPD model.
//
// This is a comfort ESTIMATE: air temperature and humidity are live from the
// sensors, while clothing, metabolic rate, air speed, and mean radiant temp
// are inferred from the household profile and sensible defaults (standard
// ASHRAE practice). It is not a medical or guaranteed-accurate measurement.
// ---------------------------------------------------------------------------

export type AgeGroup = "young_adults" | "adults" | "seniors" | "mixed"
export type ActivityLevel = "sedentary" | "moderate" | "active"

export type ComfortProfile = {
  preferred_temp_f: number
  preferred_rh: number
  age_group: AgeGroup
  activity_level: ActivityLevel
  household_size: number
  health_considerations: string[]
}

export const fToC = (f: number) => ((f - 32) * 5) / 9

// --- Fanger PMV/PPD (ISO 7730 / ASHRAE 55). Temps in °C, vel in m/s. --------
export function pmvPpd(ta: number, tr: number, vel: number, rh: number, met: number, clo: number) {
  const M = met * 58.15 // metabolic rate W/m^2 (1 met = 58.15)
  const W = 0 // external work ~0 indoors
  const mw = M - W

  const Icl = clo * 0.155 // clothing insulation m^2K/W (1 clo = 0.155)
  const fcl = Icl <= 0.078 ? 1.0 + 1.29 * Icl : 1.05 + 0.645 * Icl

  const pa = rh * 10 * Math.exp(16.6536 - 4030.183 / (ta + 235)) // water vapor pressure (Pa)

  const hcf = 12.1 * Math.sqrt(vel)
  const taa = ta + 273
  const tra = tr + 273

  let tcla = taa + (35.5 - ta) / (3.5 * Icl + 0.1)

  const p1 = Icl * fcl
  const p2 = p1 * 3.96
  const p3 = p1 * 100
  const p4 = p1 * taa
  const p5 = 308.7 - 0.028 * mw + p2 * Math.pow(tra / 100, 4)

  let xn = tcla / 100
  let xf = xn
  let hc = hcf
  let n = 0
  const eps = 0.00015

  do {
    xf = (xf + xn) / 2
    const hcn = 2.38 * Math.pow(Math.abs(100 * xf - taa), 0.25)
    hc = hcf > hcn ? hcf : hcn
    xn = (p5 + p4 * hc - p2 * Math.pow(xf, 4)) / (100 + p3 * hc)
    n++
    if (n > 150) break
  } while (Math.abs(xn - xf) > eps)

  const tcl = 100 * xn - 273

  const hl1 = 3.05 * 0.001 * (5733 - 6.99 * mw - pa) // skin diffusion
  const hl2 = mw > 58.15 ? 0.42 * (mw - 58.15) : 0 // sweating
  const hl3 = 1.7 * 0.00001 * M * (5867 - pa) // latent respiration
  const hl4 = 0.0014 * M * (34 - ta) // dry respiration
  const hl5 = 3.96 * fcl * (Math.pow(xn, 4) - Math.pow(tra / 100, 4)) // radiation
  const hl6 = fcl * hc * (tcl - ta) // convection

  const ts = 0.303 * Math.exp(-0.036 * M) + 0.028
  const pmv = ts * (mw - hl1 - hl2 - hl3 - hl4 - hl5 - hl6)

  const ppd = 100 - 95 * Math.exp(-0.03353 * Math.pow(pmv, 4) - 0.2179 * Math.pow(pmv, 2))

  return { pmv, ppd }
}

// Clothing insulation by season (Central time month).
export function cloForMonth(month0: number): number {
  // month0: 0=Jan … 11=Dec
  if (month0 >= 5 && month0 <= 8) return 0.5 // Jun–Sep summer
  if (month0 === 11 || month0 <= 1) return 1.0 // Dec–Feb winter
  return 0.7 // shoulder
}

export function metForActivity(a: ActivityLevel): number {
  return a === "sedentary" ? 1.0 : a === "active" ? 1.4 : 1.2
}

const RESPIRATORY = new Set(["asthma", "allergies", "copd"])

export type HappyResult = {
  happy: number
  pmv: number
  ppd: number
  comfortScore: number
  prefScore: number
}

// Blend ASHRAE comfort (60%) with personal preference match (40%).
export function computeHappyNumber(opts: {
  liveTempF: number
  liveRh: number
  profile: ComfortProfile
  monthCst: number
}): HappyResult {
  const { liveTempF, liveRh, profile, monthCst } = opts

  const ta = fToC(liveTempF)
  const tr = ta // assume mean radiant temp = air temp (no surface sensors)
  const vel = 0.1 // still air, blower cycling
  const met = metForActivity(profile.activity_level)
  const clo = cloForMonth(monthCst)

  const { pmv, ppd } = pmvPpd(ta, tr, vel, liveRh, met, clo)

  // 1. Comfort component
  const comfortScore = 100 - ppd

  // 2. Preference-match component
  const tempPenalty = Math.min(40, Math.abs(liveTempF - profile.preferred_temp_f) * 4)
  const hasRespiratory = profile.health_considerations.some((h) => RESPIRATORY.has(h.toLowerCase()))
  const rhCap = hasRespiratory ? 30 : 20
  const rhRaw = Math.abs(liveRh - profile.preferred_rh) * 0.5 * (hasRespiratory ? 1.5 : 1)
  const rhPenalty = Math.min(rhCap, rhRaw)
  const prefScore = 100 - tempPenalty - rhPenalty

  // 4. Final
  const happy = Math.max(0, Math.min(100, Math.round(0.6 * comfortScore + 0.4 * prefScore)))

  return { happy, pmv, ppd, comfortScore, prefScore }
}

// Plain-language band for the score.
export function happyBand(happy: number): { label: string; color: "ok" | "warn" | "bad" } {
  if (happy >= 80) return { label: "Your home feels great", color: "ok" }
  if (happy >= 60) return { label: "Comfortable, with room to fine-tune", color: "ok" }
  if (happy >= 45) return { label: "A little off from your ideal", color: "warn" }
  return { label: "Your comfort needs are quite specific — Elevate excels here", color: "warn" }
}

// Rule-based personalized recommendations (live data + profile).
export function recommendations(opts: {
  liveRh: number
  profile: ComfortProfile
}): string[] {
  const { liveRh, profile } = opts
  const out: string[] = []
  const flags = profile.health_considerations.map((h) => h.toLowerCase())

  if (liveRh > profile.preferred_rh + 10) {
    out.push("Consider a whole-home dehumidifier to maintain your preferred drier air.")
  }
  if (flags.includes("allergies") || flags.includes("asthma") || flags.includes("copd")) {
    out.push("MERV 13+ filtration recommended to reduce airborne triggers.")
  }
  if (liveRh > 50) {
    out.push("Keeping humidity below 50% helps prevent mold and dust mites.")
  }
  // Always-on cost tie-in.
  out.push("Pre-cooling before Evergy peak hours (4–8 PM) will maximize savings.")

  return out.slice(0, 4)
}
