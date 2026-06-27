"use client"

import { useState } from "react"
import { timeAgo } from "@/lib/telemetry-format"

type Row = {
  id: number
  device_id: string
  device_type: string | null
  received_at: string
  payload: Record<string, unknown>
}

export function HistoryFeed({ rows }: { rows: Row[] }) {
  const [open, setOpen] = useState(false)

  return (
    <section className="rounded-2xl border border-border bg-card shadow-lg shadow-black/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="text-sm font-semibold text-foreground">
          Recent Raw Readings{" "}
          <span className="ml-1 font-normal text-muted">({rows.length})</span>
        </span>
        <span
          className={`text-muted transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        >
          ▾
        </span>
      </button>

      {open ? (
        <div className="max-h-[28rem] overflow-auto border-t border-border">
          {rows.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted">No readings received yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((row) => (
                <li key={row.id} className="px-4 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-mono text-xs font-medium text-foreground">
                      {row.device_id}
                    </span>
                    <span className="shrink-0 text-xs text-muted">{timeAgo(row.received_at)}</span>
                  </div>
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
                    {JSON.stringify(row.payload)}
                  </pre>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  )
}
