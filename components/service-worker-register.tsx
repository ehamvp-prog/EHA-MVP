"use client"

import { useEffect } from "react"

// Service worker lifecycle manager.
//
// IMPORTANT: a service worker is only registered in PRODUCTION. In `next dev`,
// an active SW conflicts with Hot Module Replacement and the App Router's RSC
// navigation, which causes a full-page reload loop. This mirrors how next-pwa
// disables the SW in development.
//
// In development we go a step further and actively UNREGISTER any previously
// installed SW (and clear its caches), so a preview that picked up an old SW
// heals itself instead of staying stuck in a reload loop.
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return
    if (!("serviceWorker" in navigator)) return

    const isProd = process.env.NODE_ENV === "production"

    if (!isProd) {
      // Dev: tear down any existing SW + caches.
      navigator.serviceWorker.getRegistrations().then((regs) => {
        regs.forEach((reg) => reg.unregister())
      })
      if ("caches" in window) {
        caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)))
      }
      return
    }

    // Prod: register the SW once the page has loaded.
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* registration failures are non-fatal — app still works as a normal site */
      })
    }

    if (document.readyState === "complete") register()
    else window.addEventListener("load", register, { once: true })
  }, [])

  return null
}
