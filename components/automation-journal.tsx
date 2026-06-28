"use client"

import { useState } from "react"
import useSWR from "swr"
import {
  History,
  Snowflake,
  Wind,
  ShieldCheck,
  Lightbulb,
  TrendingDown,
  ChevronDown,
  CheckCircle2,
  Clock,
} from "lucide-react"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

type JournalEntry = {
  id: string
  occurred_at: string
  action_type: string
  trigger_reason: string | null
  command_sent: Record<string, unknown> | null
  nest_confirmed: boolean | null
  before_state: { comfort_score?: number | null } | null
  after_state: { comfort_score?: number | null } | null
  est_savings_usd: number | null
  est_comfort_delta: number | null
}

// Only render once the homeowner has automation history worth reviewing.
export function AutomationJournalCard() {
  const { data } = useSWR<{ ok: boolean; entries: JournalEntry[] }>(
    "/api/automation/journal",
    fetcher,
    { refreshInterval: 60000 },
  )
  const [expanded, setExpanded] = useState(false)
  const entries = data?.entries ?? []

  if (entries.length === 0) return null

  const visible = expanded ? entries : entries.slice(0, 4)
  const totalSavings = entries.reduce((sum, e) => sum + (e.est_savings_usd ?? 0), 0)

  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-lg shadow-black/40">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-elevated">
            <History className="h-5 w-5 text-primary" />
          </span>
          <div>
            <h3 className="text-base font-semibold text-foreground">Automation Journal</h3>
            <p className="text-xs text-muted">What Elevate did for you, and what it saved.</p>
          </div>
        </div>
        {totalSavings > 0 ? (
          <div className="shrink-0 rounded-xl border border-ok/30 bg-ok/10 px-3 py-1.5 text-right">
            <p className="text-[10px] uppercase tracking-wide text-muted">Saved</p>
            <p className="text-sm font-bold tabular-nums text-ok">${totalSavings.toFixed(2)}</p>
          </div>
        ) : null}
      </div>

      <ul className="flex flex-col gap-2">
        {visible.map((e) => (
          <JournalRow key={e.id} entry={e} />
        ))}
      </ul>

      {entries.length > 4 ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mt-3 flex w-full items-center justify-center gap-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? "Show less" : `Show all ${entries.length} actions`}
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
        </button>
      ) : null}
    </div>
  )
}

function JournalRow({ entry }: { entry: JournalEntry }) {
  const meta = actionMeta(entry.action_type)
  const Icon = meta.icon
  const before = entry.before_state?.comfort_score
  const after = entry.after_state?.comfort_score

  return (
    <li className="flex items-start gap-3 rounded-xl border border-border bg-elevated p-3">
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${meta.badge}`}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-foreground">{meta.label}</span>
          <span className="shrink-0 text-[11px] text-muted">{when(entry.occurred_at)}</span>
        </div>
        {entry.trigger_reason ? (
          <p className="mt-0.5 text-xs text-muted-foreground text-pretty">{entry.trigger_reason}</p>
        ) : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          {entry.est_savings_usd != null && entry.est_savings_usd > 0 ? (
            <span className="flex items-center gap-1 text-ok">
              <TrendingDown className="h-3 w-3" /> Saved ${entry.est_savings_usd.toFixed(2)}
            </span>
          ) : null}
          {before != null && after != null ? (
            <span className="text-muted">
              Comfort {before} → {after}
            </span>
          ) : null}
          {entry.command_sent == null && entry.action_type === "recommendation" ? null : (
            <ConfirmBadge confirmed={entry.nest_confirmed} hadCommand={entry.command_sent != null} />
          )}
        </div>
      </div>
    </li>
  )
}

// Honest confirmation: did Nest read back the expected state, or is it pending,
// or did the command not take (some fan/setpoint commands can be overridden)?
function ConfirmBadge({ confirmed, hadCommand }: { confirmed: boolean | null; hadCommand: boolean }) {
  if (!hadCommand) return null
  if (confirmed === true) {
    return (
      <span className="flex items-center gap-1 text-ok">
        <CheckCircle2 className="h-3 w-3" /> Confirmed
      </span>
    )
  }
  if (confirmed === false) {
    return (
      <span className="flex items-center gap-1 text-warn">
        <Clock className="h-3 w-3" /> Didn&apos;t take
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1 text-muted">
      <Clock className="h-3 w-3" /> Pending confirmation
    </span>
  )
}

function actionMeta(type: string): {
  label: string
  icon: typeof Snowflake
  badge: string
} {
  switch (type) {
    case "peak_precool":
      return { label: "Pre-cooled before peak", icon: Snowflake, badge: "bg-primary/15 text-primary" }
    case "peak_coast":
      return { label: "Coasting through peak", icon: TrendingDown, badge: "bg-ok/15 text-ok" }
    case "comfort_adjust":
      return { label: "Comfort adjustment", icon: ShieldCheck, badge: "bg-primary/15 text-primary" }
    case "fan_circulate":
      return { label: "Fan circulation", icon: Wind, badge: "bg-accent/15 text-accent" }
    case "recommendation":
      return { label: "Recommendation", icon: Lightbulb, badge: "bg-warn/15 text-warn" }
    default:
      return { label: "Automation", icon: ShieldCheck, badge: "bg-elevated text-muted-foreground" }
  }
}

function when(iso: string): string {
  const d = new Date(iso)
  const diffMs = Date.now() - d.getTime()
  const mins = Math.round(diffMs / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}
