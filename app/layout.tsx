import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import "./globals.css"
import { ServiceWorkerRegister } from "@/components/service-worker-register"

const geistSans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" })
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" })

export const metadata: Metadata = {
  title: "Elevate Home App — HVAC Efficiency",
  description:
    "Live HVAC efficiency, measured SEER2 estimate, live Evergy cost, and anomaly detection for a single home.",
  // Links the PWA manifest and iOS home-screen metadata so the app installs
  // standalone with proper branding.
  manifest: "/manifest.webmanifest",
  applicationName: "Elevate Home",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Elevate",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
  },
}

export const viewport: Viewport = {
  themeColor: "#0b0f14",
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} bg-background`}>
      <body className="font-sans antialiased">
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  )
}
