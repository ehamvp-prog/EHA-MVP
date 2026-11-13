"use client"

import { useState } from "react"
import useSWR from "swr"
import { GAS_HEATING_VALUE_BTU_PER_CUFT, inputBtuhFromClock } from "@/lib/engine/heating/afue"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

// ---- Clock the meter --------------------------------------------------------
// Time one full turn of the gas meter's test dial with only the furnace
// running, pick the dial size, and this works out the real gas input.

export function MeterClock({
  label,
  gasType,
  heatingValue,
  onUse,
  disabled,
}: {
  label: string
  gasType: string
  heatingValue: string
  onUse: (btuh: number) => void
  disabled?: boolean
}) {
  const [seconds, setSeconds] = useState("")
  const [dial, setDial] = useState("1")
  const hv =
    Number(heatingValue) > 0
      ? Number(heatingValue)
      : GAS_HEATING_VALUE_BTU_PER_CUFT[gasType === "propane" ? "propane" : "natural_gas"]
  const btuh = inputBtuhFromClock(Number(seconds), Number(dial), hv)

  return (
    <div className="rounded-xl border border-border bg-elevated p-3">
      <p className="text-sm font-medium text-foreground">{label}</p>
      <p className="mt-0.5 text-xs text-muted">
        Everything else on gas off. Stopwatch one full turn of the meter&apos;s test dial.
      </p>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted">Seconds per turn</span>
          <input
            type="number"
            inputMode="decimal"
            value={seconds}
            disabled={disabled}
            onChange={(e) => setSeconds(e.target.value)}
            placeholder="e.g. 45"
            className="w-full rounded-lg border border-border bg-input px-2.5 py-2 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted">Dial size</span>
          <select
            value={dial}
            disabled={disabled}
            onChange={(e) => setDial(e.target.value)}
            className="w-full rounded-lg border border-border bg-input px-2.5 py-2 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60"
          >
            <option value="0.5">½ cubic foot</option>
            <option value="1">1 cubic foot</option>
            <option value="2">2 cubic feet</option>
            <option value="5">5 cubic feet</option>
          </select>
        </label>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <p className="text-sm tabular-nums text-foreground">
          {btuh != null ? `${Math.round(btuh).toLocaleString()} BTU/h` : "—"}
          <span className="ml-1 text-[11px] text-muted">at {hv} BTU/ft³</span>
        </p>
        <button
          type="button"
          disabled={disabled || btuh == null}
          onClick={() => btuh != null && onUse(Math.round(btuh))}
          className="rounded-lg border border-primary/50 px-3 py-1.5 text-xs font-semibold text-primary disabled:opacity-40"
        >
          Use this
        </button>
      </div>
    </div>
  )
}

// ---- Furnace signature ---------------------------------------------------------

type Sig = Record<string, number | boolean | string | null>

const SIG_ROWS: { key: string; label: string }[] = [
  { key: "fan_only_w", label: "Fan only" },
  { key: "inducer_only_w", label: "Inducer (starting)" },
  { key: "ignition_w", label: "Igniter" },
  { key: "burn_single_w", label: "Burning" },
  { key: "post_purge_blower_w", label: "Blower after burn" },
  { key: "cooling_blower_w", label: "AC blower" },
]

export function FurnaceSignaturePanel({ disabled }: { disabled?: boolean }) {
  const { data, mutate } = useSWR<{ ok: boolean; signature: Sig | null }>("/api/heating/signature", fetcher)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const sig = data?.signature ?? null

  async function learn() {
    setBusy(true)
    setMsg(null)
    try {
      const r = await fetch("/api/heating/signature", { method: "POST" })
      const j = await r.json()
      if (!j.ok) setMsg({ ok: false, text: j.error ?? "Couldn't learn the signature." })
      else {
        setMsg({ ok: true, text: "Learned from the last heat run and saved." })
        mutate()
      }
    } catch {
      setMsg({ ok: false, text: "Couldn't reach the server." })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-border bg-elevated p-3 sm:col-span-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-foreground">Furnace power signature</p>
          <p className="mt-0.5 text-xs text-muted">
            The power draw of each step of the furnace&apos;s start-up and burn. The app uses it to tell starting, lighting,
            burning and shutting down apart. Learned from this furnace&apos;s last heat run.
          </p>
        </div>
        <span
          className={`shrink-0 rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wide ${
            sig?.commissioned ? "border-ok/40 text-ok" : "border-border text-muted"
          }`}
        >
          {sig?.commissioned ? "Learned" : "Default"}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {SIG_ROWS.map((r) => (
          <div key={r.key} className="rounded-lg border border-border bg-card p-2 text-center">
            <p className="text-[10px] text-muted">{r.label}</p>
            <p className="text-sm tabular-nums text-foreground">
              {typeof sig?.[r.key] === "number" ? `${sig[r.key]} W` : "—"}
            </p>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <p className={`text-xs ${msg ? (msg.ok ? "text-ok" : "text-bad") : "text-muted"}`}>
          {msg?.text ??
            (typeof sig?.learned_at === "string" ? `Last learned ${new Date(sig.learned_at).toLocaleDateString()}` : "Run the heat 15 minutes first.")}
        </p>
        <button
          type="button"
          onClick={learn}
          disabled={disabled || busy}
          className="shrink-0 rounded-lg border border-primary/50 px-3 py-1.5 text-xs font-semibold text-primary disabled:opacity-40"
        >
          {busy ? "Learning…" : "Learn from last heat run"}
        </button>
      </div>
    </div>
  )
}

// ---- Gas price (automatic) ---------------------------------------------------

type GasPrice = {
  ok: boolean
  source: "kansas_gas_service" | "manual" | "none"
  per_mcf: number | null
  per_therm: number | null
  cost_of_gas_per_mcf: number | null
  delivery_per_mcf: number | null
  period: string | null
  checked_at: string | null
}

export function GasPricePanel() {
  const { data } = useSWR<GasPrice>("/api/gas/price", fetcher)
  const money = (n: number | null | undefined, d = 2) => (n == null ? "—" : `$${n.toFixed(d)}`)
  return (
    <div className="rounded-xl border border-border bg-elevated p-3 sm:col-span-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground">Gas price</p>
        <span className="shrink-0 rounded-md border border-ok/40 px-2 py-0.5 text-[10px] uppercase tracking-wide text-ok">
          {data?.source === "manual" ? "Manual" : "Automatic"}
        </span>
      </div>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
        {money(data?.per_mcf)}
        <span className="text-sm font-normal text-muted"> per Mcf</span>
      </p>
      {data?.source === "kansas_gas_service" ? (
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Kansas Gas Service cost of gas {money(data.cost_of_gas_per_mcf, 4)}
          {data.period ? ` (${data.period})` : ""} + delivery charge {money(data.delivery_per_mcf, 4)}. Checked daily.
          About {money(data.per_therm, 3)} per therm. The monthly service charge and city fees aren&apos;t included —
          they don&apos;t change with how much the furnace runs.
        </p>
      ) : data?.source === "manual" ? (
        <p className="mt-1 text-xs text-muted">Using the override below.</p>
      ) : (
        <p className="mt-1 text-xs text-muted">Waiting for the first Kansas Gas Service price check.</p>
      )}
    </div>
  )
}
