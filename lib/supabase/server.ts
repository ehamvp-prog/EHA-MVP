import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"

// Server-side client that uses the public anon key + cookies.
// Used for reads from Server Components. RLS applies (no login = no rows
// for anon), so for the MVP we mainly use the admin client below.
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Called from a Server Component — safe to ignore.
          }
        },
      },
    }
  )
}
