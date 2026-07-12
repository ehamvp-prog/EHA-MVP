import type { MetadataRoute } from "next"

// Web App Manifest — makes the app meet PWA install criteria so mobile
// browsers offer a real "Install app" (standalone, full-screen) instead of a
// plain bookmark/shortcut. Served at /manifest.webmanifest by Next.js.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Elevate Home",
    short_name: "Elevate",
    description:
      "Live HVAC efficiency, measured SEER2 estimate, live Evergy cost, and anomaly detection for your home.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0b0f14",
    theme_color: "#0b0f14",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  }
}
