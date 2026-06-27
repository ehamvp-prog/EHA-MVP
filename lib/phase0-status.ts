import { createAdminClient } from "@/lib/supabase/admin"

export type TableStatus = {
  name: string
  ok: boolean
  count: number | null
  error: string | null
}

export type Phase0Status = {
  envOk: boolean
  missingEnv: string[]
  tables: TableStatus[]
}

const REQUIRED_ENV = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "TELEMETRY_INGEST_SECRET",
]

const TABLES = ["telemetry", "system_profile", "computed_readings"]

export async function getPhase0Status(): Promise<Phase0Status> {
  const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k])
  const envOk = missingEnv.length === 0

  const tables: TableStatus[] = []

  if (envOk) {
    const supabase = createAdminClient()
    for (const name of TABLES) {
      const { count, error } = await supabase
        .from(name)
        .select("*", { count: "exact", head: true })
      tables.push({
        name,
        ok: !error,
        count: count ?? null,
        error: error?.message ?? null,
      })
    }
  } else {
    for (const name of TABLES) {
      tables.push({
        name,
        ok: false,
        count: null,
        error: "Skipped — Supabase keys missing.",
      })
    }
  }

  return { envOk, missingEnv, tables }
}
