import { createClient as createSupabaseClient } from "@supabase/supabase-js"

// Admin client — uses the SERVICE ROLE key. This bypasses RLS.
// NEVER import this in client/browser code. Server-only.
// This is what writes telemetry and computed_readings, and reads
// data back for the owner-only dashboard (no login by design).
let adminSingleton: ReturnType<typeof createSupabaseClient> | null = null

export function createAdminClient() {
  if (adminSingleton) return adminSingleton

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !serviceKey) {
    throw new Error(
      "Missing Supabase env vars. Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
    )
  }

  adminSingleton = createSupabaseClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  return adminSingleton
}
