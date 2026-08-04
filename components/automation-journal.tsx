"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import {
  History,
  Snowflake,
  Wind,
  ShieldCheck,
  Lightbulb,
  TrendingDown,
  TrendingUp,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
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
  // NOTE: est_savings_usd is deprecated (hardcoded formula) and intentionally
  // NOT read here — measured savings come from /api/savings/events instead.
}

// Per-action measured effect, keyed by id === automation_journal.id.
type SavingsEvent = {
  id: string
  occurred_at: string
  action_type: string
  measured_savings_usd: number | null
  confidence: string
  limiting_factors: string[]
  explanation: string | null
}

type SavingsSummary = {
  ok: boolean
  month: string
  net_savings_usd: number
  gross_savings_usd: number
  costs_usd: number
  actions: number
  unmeasurable_actions: number
}

// A row in the rendered journal: a real automated action, a collapsed "System
// steady" span standing in for a run of quiet check-ins, or a standalone
// free-cooling daily summary. Free cooling has no automation_journal row (its
// id is a deterministic hash, not a journal id), so it rides in as its own kind
// rather than enriching an action.
type DisplayItem =
  | { kind: "action"; entry: JournalEntry }
  | { kind: "steady"; id: string; startAt: string; endAt: string; count: number }
  | { kind: "freecooling"; id: string; event: SavingsEvent }

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

// Timestamp a display item sorts by (newest-first). Steady spans sort by their
// most recent check-in.
function itemTime(item: DisplayItem): number {
  if (item.kind === "action") return new Date(item.entry.occurred_at).getTime()
  if (item.kind === "freecooling") return new Date(item.event.occurred_at).getTime()
  return new Date(item.endAt).getTime()
}

// Interleave free-cooling daily summaries into the journal by time. They arrive
// via /api/savings/events (keyed by a deterministic hash id, not a journal id),
// so they can't enrich an action row — they stand on their own.
function mergeFreeCooling(items: DisplayItem[], events: SavingsEvent[]): DisplayItem[] {
  const fc = events
    .filter((e) => e.action_type === "free_cooling")
    .map<DisplayItem>((event) => ({ kind: "freecooling", id: `fc-${event.id}`, event }))
  if (fc.length === 0) return items
  return [...items, ...fc].sort((a, b) => itemTime(b) - itemTime(a))
}

// Only render once the homeowner has automation history worth reviewing.
export function AutomationJournalCard() {
  const { data } = useSWR<{ ok: boolean; entries: JournalEntry[] }>(
    "/api/automation/journal",
    fetcher,
    { refreshInterval: 60000 },
  )
  // Measured savings for the current month + per-action measured effects,
  // both derived from real power data (not the deprecated est_savings_usd).
  const { data: summary } = useSWR<SavingsSummary>("/api/savings/summary", fetcher, {
    refreshInterval: 60000,
  })
  const { data: eventsData } = useSWR<{ ok: boolean; events: SavingsEvent[] }>(
    "/api/savings/events",
    fetcher,
    { refreshInterval: 60000 },
  )
  const [page, setPage] = useState(0)
  // Collapsed by default — expands only when the user opens it.
  const [collapsed, setCollapsed] = useState(true)
  const entries = data?.entries ?? []

  const eventById = useMemo(() => {
    const m = new Map<string, SavingsEvent>()
    for (const ev of eventsData?.events ?? []) m.set(ev.id, ev)
    return m
  }, [eventsData])

  if (entries.length === 0) return null

  const measuredNet = summary?.net_savings_usd ?? 0
  const hasMeasured = !!summary && summary.actions > 0

  // Collapse noisy consecutive "check-in" rows into a single "System steady"
  // marker, so the journal reads as a list of things that actually happened.
  // Then fold in free-cooling daily summaries as standalone rows, time-ordered
  // alongside the automation actions (they have no journal row to attach to).
  const items = mergeFreeCooling(buildDisplayItems(entries), eventsData?.events ?? [])

  // Paginate: 5 display items per page, newest first. "Older" pages back in
  // time; there's no infinite scroll to blow up the screen.
  const PAGE_SIZE = 5
  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const visible = items.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)

  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-lg shadow-black/40">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border bg-elevated">
            <History className="h-5 w-5 text-primary" />
          </span>
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-foreground">Automation Journal</h3>
            <p className="truncate text-xs text-muted">What Elevate did for you, and what it saved.</p>
          </div>
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-muted transition-transform ${collapsed ? "" : "rotate-180"}`}
          />
        </button>
        {hasMeasured ? (
          <div
            className={`shrink-0 rounded-xl border px-3 py-1.5 text-right ${
              measuredNet < 0 ? "border-warn/30 bg-warn/10" : "border-ok/30 bg-ok/10"
            }`}
          >
            <p className="text-[10px] uppercase tracking-wide text-muted">Measured savings</p>
            <p
              className={`text-sm font-bold tabular-nums ${measuredNet < 0 ? "text-warn" : "text-ok"}`}
            >
              {measuredNet < 0 ? "-" : ""}${Math.abs(measuredNet).toFixed(2)}
            </p>
          </div>
        ) : null}
      </div>

      {collapsed ? null : (
        <>
          <ul className="mt-3 flex flex-col gap-2">
            {visible.map((item) =>
              item.kind === "steady" ? (
                <SteadyRow key={item.id} item={item} />
              ) : item.kind === "freecooling" ? (
                <FreeCoolingRow key={item.id} event={item.event} />
              ) : (
                <JournalRow key={item.entry.id} entry={item.entry} event={eventById.get(item.entry.id)} />
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
        </>
      )}
    </div>
  )
}

function JournalRow({ entry, event }: { entry: JournalEntry; event?: SavingsEvent }) {
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
          <SavingsEffect event={event} />
          {before != null && after != null ? (
            <span className="text-muted">
              Comfort {before} → {after}
            </span>
          ) : null}
          {entry.command_sent == null && entry.action_type === "recommendation" ? null : (
            <ConfirmBadge confirmed={entry.nest_confirmed} hadCommand={entry.command_sent != null} />
          )}
        </div>

        {/* Plain-language explanation of what was measured. */}
        {event?.explanation ? (
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground text-pretty">
            {event.explanation}
          </p>
        ) : null}

        {/* Honest notes on what limited the result. */}
        {event && event.limiting_factors.length > 0 ? (
          <ul className="mt-1 flex flex-col gap-0.5">
            {event.limiting_factors.map((lf, i) => (
              <li key={i} className="flex items-start gap-1.5 text-[11px] text-muted">
                <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted" />
                <span className="text-pretty">{lf}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  )
}

// The measured effect chip. Confidence governs how the number is shown — the
// whole point of the rebuild is to read honestly rather than print "$0.00".
function SavingsEffect({ event }: { event?: SavingsEvent }) {
  if (!event) return null
  const { confidence, measured_savings_usd: amt } = event

  if (confidence === "none") return <span className="text-muted">No measurable effect</span>
  if (confidence === "insufficient_data")
    return <span className="text-muted">Not enough data to measure</span>
  if (amt == null) return <span className="text-muted">No measurable effect</span>

  const soft = confidence === "low" // low confidence → visually softened

  // Negative = pre-cooling spent money at off-peak to avoid on-peak. Honest cost.
  if (amt < 0) {
    return (
      <span className={`flex items-center gap-1 ${soft ? "text-muted" : "text-muted-foreground"}`}>
        <TrendingUp className="h-3 w-3" /> Cost ${Math.abs(amt).toFixed(2)}
      </span>
    )
  }
  return (
    <span className={`flex items-center gap-1 ${soft ? "text-ok/60" : "text-ok"}`}>
      <TrendingDown className="h-3 w-3" /> Saved ${amt.toFixed(2)}
    </span>
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

// A free-cooling daily summary. Not an automation action — it's the measured
// cooling recovered off the coil after each compressor cycle, rolled up per
// day. Explanation text comes prewritten from the savings engine.
function FreeCoolingRow({ event }: { event: SavingsEvent }) {
  const amt = event.measured_savings_usd
  return (
    <li className="flex items-start gap-3 rounded-xl border border-accent/25 bg-elevated p-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
        <Snowflake className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-foreground">Free cooling</span>
          <span className="shrink-0 text-[11px] text-muted">{when(event.occurred_at)}</span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          {amt != null && amt > 0 ? (
            <span className="flex items-center gap-1 text-ok">
              <TrendingDown className="h-3 w-3" /> Saved ${amt.toFixed(2)}
            </span>
          ) : (
            <span className="text-muted">No free cooling recovered</span>
          )}
        </div>
        {event.explanation ? (
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground text-pretty">
            {event.explanation}
          </p>
        ) : null}
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
