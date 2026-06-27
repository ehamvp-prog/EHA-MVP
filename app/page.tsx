import { getPhase0Status } from "@/lib/phase0-status"

export const dynamic = "force-dynamic"

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-2.5 w-2.5 rounded-full"
      style={{ backgroundColor: ok ? "var(--color-ok)" : "var(--color-bad)" }}
    />
  )
}

export default async function Page() {
  const status = await getPhase0Status()
  const tablesOk = status.tables.every((t) => t.ok)
  const allGood = status.envOk && tablesOk

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-8 px-5 py-12">
      <header className="flex flex-col gap-2">
        <p className="text-sm font-medium text-primary">Elevate Home App</p>
        <h1 className="text-balance text-3xl font-semibold leading-tight">
          Phase 0 — Foundation
        </h1>
        <p className="text-pretty leading-relaxed text-muted">
          This page checks that the base is wired up: the connection keys, the
          three database tables, and the sensor data endpoint. No HVAC math or
          dashboard yet — those come in later phases.
        </p>
      </header>

      <section
        className="rounded-lg border p-5"
        style={{
          borderColor: "var(--color-border)",
          backgroundColor: "var(--color-card)",
        }}
      >
        <div className="flex items-center gap-3">
          <StatusDot ok={allGood} />
          <h2 className="text-lg font-medium">
            {allGood ? "Foundation is live" : "Foundation needs attention"}
          </h2>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          {allGood
            ? "Everything is connected. Phase 0 is complete and ready for Phase 1 (sensor and weather ingest)."
            : "Something below is not ready yet. See the checklist."}
        </p>
      </section>

      {/* Connection keys */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
          Connection keys
        </h2>
        <div
          className="flex items-center gap-3 rounded-lg border p-4"
          style={{
            borderColor: "var(--color-border)",
            backgroundColor: "var(--color-card)",
          }}
        >
          <StatusDot ok={status.envOk} />
          <div className="flex flex-col">
            <span className="text-sm font-medium">
              {status.envOk ? "All keys present" : "Missing keys"}
            </span>
            {!status.envOk && (
              <span className="text-sm text-muted">
                {status.missingEnv.join(", ")}
              </span>
            )}
          </div>
        </div>
      </section>

      {/* Tables */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
          Database tables
        </h2>
        <div className="flex flex-col gap-2">
          {status.tables.map((t) => (
            <div
              key={t.name}
              className="flex items-center justify-between rounded-lg border p-4"
              style={{
                borderColor: "var(--color-border)",
                backgroundColor: "var(--color-card)",
              }}
            >
              <div className="flex items-center gap-3">
                <StatusDot ok={t.ok} />
                <span className="font-mono text-sm">{t.name}</span>
              </div>
              <span className="text-sm text-muted">
                {t.ok
                  ? `${t.count ?? 0} row${t.count === 1 ? "" : "s"}`
                  : (t.error ?? "error")}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Sensor endpoint */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
          Sensor data endpoint
        </h2>
        <div
          className="rounded-lg border p-4"
          style={{
            borderColor: "var(--color-border)",
            backgroundColor: "var(--color-card)",
          }}
        >
          <p className="text-sm leading-relaxed">
            Your Shelly scripts should POST to:
          </p>
          <code className="mt-2 block rounded-md bg-background px-3 py-2 font-mono text-sm text-primary">
            /api/telemetry/ingest
          </code>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            Each request must include the header{" "}
            <span className="font-mono">Authorization: Bearer &lt;secret&gt;</span>.
            The raw payload is stored in the telemetry table untouched.
          </p>
        </div>
      </section>
    </main>
  )
}
