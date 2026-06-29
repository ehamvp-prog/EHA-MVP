// Elevate Home — minimal, conflict-free service worker.
//
// Hard-won lesson: a SW that intercepts navigations / Next.js assets in this
// app causes a reload loop (stale HTML referencing rotated build chunks). So
// this worker DELIBERATELY does not touch navigations, /_next/, or /api/ — it
// lets the browser handle them normally. It only:
//   1. Exists with a fetch handler (required for PWA installability), and
//   2. Lazily caches the app icons so they're available offline.
//
// `activate` nukes every previously-created cache, which also heals any older
// build of this worker that had cached HTML/JS.

const ICON_CACHE = "elevate-icons-v3"

self.addEventListener("install", () => {
  // Nothing that can fail — guarantees the worker reaches activation.
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k !== ICON_CACHE).map((k) => caches.delete(k)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener("fetch", (event) => {
  const { request } = event
  if (request.method !== "GET") return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // ONLY handle icons. Everything else (navigations, /_next/, /api/, HMR) is
  // intentionally left to the browser to avoid any interference.
  if (!url.pathname.startsWith("/icons/")) return

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          const copy = response.clone()
          caches.open(ICON_CACHE).then((cache) => cache.put(request, copy))
          return response
        }),
    ),
  )
})
