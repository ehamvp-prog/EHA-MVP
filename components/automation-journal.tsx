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
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Clock,
  Filter,
  Minus,
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

// A row in the rendered journal: either a real automated action, or a
// collapsed "System steady" span that stands in for a run of quiet check-ins.
type DisplayItem =
  | { kind: "action"; entry: JournalEntry }
  | { kind: "steady"; id: string; startAt: string; endAt: string; count: number }

// Collapse consecutive "evaluation" (check-in) rows into a single steady
// marker. Real actions pass through untouched. Input is newest-first, and
// order is preserved.
function buildDisplayItems(entries: JournalEntry[]): DisplayItem[] {
  const items: DisplayItem[] = []
  let run: JournalEntry[] = []

  const flush = () => {
    if (run.length === 0) return
    const newest = run[0]
    const oldest = run[run.length - 1]
    items.push({
      kind: "steady",
      id: `steady-${oldest.id}-${newest.id}`,
      startAt: oldest.occurred_at,
      endAt: newest.occurred_at,
      count: run.length,
    })
    run = []
  }

  for (const e of entries) {
    if (e.action_type === "evaluation") {
      run.push(e)
    } else {
      flush()
      items.push({ kind: "action", entry: e })
    }
  }
  flush()
  return items
}

// Only render once the homeowner has automation history worth reviewing.
export function AutomationJournalCard() {
  const { data } = useSWR<{ ok: boolean; entries: JournalEntry[] }>(
    "/api/automation/journal",
    fetcher,
    { refreshInterval: 60000 },
  )
  const [page, setPage] = useState(0)
  const entries = data?.entries ?? []

  if (entries.length === 0) return null

  const totalSavings = entries.reduce((sum, e) => sum + (e.est_savings_usd ?? 0), 0)

  // Collapse noisy consecutive "check-in" rows into a single "System steady"
  // marker, so the journal reads as a list of things that actually happened.
  const items = buildDisplayItems(entries)

  // Paginate: 10 display items per page, newest first. "Older" pages back in
  // time; there's no infinite scroll to blow up the screen.
  const PAGE_SIZE = 10
  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const visible = items.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)

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
        {visible.map((item) =>
          item.kind === "steady" ? (
            <SteadyRow key={item.id} item={item} />
          ) : (
            <JournalRow key={item.entry.id} entry={item.entry} />
          ),
        )}
      </ul>

      {pageCount > 1 ? (
        <div className="mt-3 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={safePage === 0}
            className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Newer
          </button>
          <span className="text-[11px] tabular-nums text-muted">
            Page {safePage + 1} of {pageCount}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            disabled={safePage >= pageCount - 1}
            className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            Older <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-[11px] text-muted">
        <ShieldCheck className="h-3 w-3 shrink-0" />
        Automation runs automatically in the background — even when this app is closed.
      </p>
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

// A collapsed run of quiet check-ins: the system was holding your comfort with
// nothing to do. Shown as one muted, dashed row instead of dozens of "Checked
// in" lines.
function SteadyRow({ item }: { item: Extract<DisplayItem, { kind: "steady" }> }) {
  const span = new Date(item.endAt).getTime() - new Date(item.startAt).getTime()
  const spanLabel = duration(span)
  const detail =
    item.count > 1
      ? `Held your comfort with no changes needed${spanLabel ? ` over ${spanLabel}` : ""}`
      : "Held your comfort — no change needed"

  return (
    <li className="flex items-start gap-3 rounded-xl border border-dashed border-border bg-elevated/50 p-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-elevated text-muted-foreground">
        <Minus className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-muted-foreground">System steady</span>
          <span className="shrink-0 text-[11px] text-muted">{when(item.endAt)}</span>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground text-pretty">{detail}</p>
      </div>
    </li>
  )
}

// Human-friendly duration for a steady span. Returns "" for sub-minute spans.
function duration(ms: number): string {
  const mins = Math.round(ms / 60000)
  if (mins < 1) return ""
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  const remMins = mins % 60
  if (hrs < 24) return remMins ? `${hrs}h ${remMins}m` : `${hrs}h`
  const days = Math.floor(hrs / 24)
  const remHrs = hrs % 24
  return remHrs ? `${days}d ${remHrs}h` : `${days}d`
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
    case "evaluation":
      return { label: "Checked in", icon: Clock, badge: "bg-elevated text-muted-foreground" }
    case "filter_change":
      return { label: "Filter change", icon: Filter, badge: "bg-accent/15 text-accent" }
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
