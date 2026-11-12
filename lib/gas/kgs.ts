// =====================================================================
// Kansas Gas Service — monthly Cost of Gas.
//
// KGS bills residential gas per Mcf (1,000 ft³). The part that moves every
// month is the "Cost of Gas" — the market price passed through at cost. KGS
// posts it as a one-page PDF. This reads that PDF and returns $/Mcf.
// The delivery charge ($2.9769/Mcf, Schedule 20) only changes in a rate case,
// so it lives in system_profile.gas_delivery_per_mcf.
//
// A database trigger turns cost-of-gas + delivery into the $/therm the engine
// uses, so nobody types a gas price.
// =====================================================================

import { inflateSync } from "node:zlib"

export const KGS_COST_OF_GAS_URL = "https://www.kansasgasservice.com/media/KGS/Tariffs/current_costofgas.pdf"

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

export interface KgsCostOfGas {
  perMcf: number
  period: string | null // e.g. "November 2026"
  text: string // decoded text, for troubleshooting
}

// Pull the readable text out of a simple PDF: inflate every compressed stream
// and collect the strings inside (...) — that's where Tj/TJ text lives.
export function pdfText(bytes: Buffer): string {
  const raw = bytes.toString("latin1")
  const chunks: string[] = []
  const re = /stream\r?\n/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length
    const end = raw.indexOf("endstream", start)
    if (end < 0) break
    const body = bytes.subarray(start, end)
    let decoded: string
    try {
      decoded = inflateSync(body).toString("latin1")
    } catch {
      decoded = body.toString("latin1")
    }
    const strings = decoded.match(/\((?:\\.|[^\\)])*\)/g)
    if (strings) chunks.push(strings.map((x) => x.slice(1, -1).replace(/\\(.)/g, "$1")).join(""))
    else chunks.push(decoded)
    re.lastIndex = end
  }
  return chunks.join(" ").replace(/\s+/g, " ")
}

// Find the $/Mcf figure and the month it covers.
export function parseCostOfGas(text: string): { perMcf: number | null; period: string | null } {
  // Natural gas cost of gas runs a few dollars per Mcf; KGS prints 4 decimals.
  const nums = Array.from(text.matchAll(/\$?\s?(\d{1,2}\.\d{4})/g))
    .map((x) => Number(x[1]))
    .filter((n) => n >= 1 && n <= 40)
  const monthRe = new RegExp(`(${MONTHS.join("|")})\\s*,?\\s*(20\\d{2})`, "i")
  const pm = text.match(monthRe)
  const period = pm ? `${pm[1][0].toUpperCase()}${pm[1].slice(1).toLowerCase()} ${pm[2]}` : null
  return { perMcf: nums.length ? nums[0] : null, period }
}

export async function fetchKgsCostOfGas(): Promise<KgsCostOfGas> {
  const res = await fetch(KGS_COST_OF_GAS_URL, {
    headers: { "user-agent": "ElevateHomeApp/1.0 (+https://app.elevateks.com)" },
    cache: "no-store",
  })
  if (!res.ok) throw new Error(`Kansas Gas Service cost-of-gas sheet: HTTP ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  const text = pdfText(bytes)
  const { perMcf, period } = parseCostOfGas(text)
  if (perMcf == null) throw new Error("Couldn't find the $/Mcf cost of gas on the Kansas Gas Service sheet.")
  return { perMcf, period, text: text.slice(0, 600) }
}
