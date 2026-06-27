"use client"

type Props = {
  value: number
  min: number
  max: number
  label: string
  unit?: string
  size?: number
  accent?: "primary" | "accent" | "ok" | "warn" | "orange" | "bad"
}

const ACCENT_HEX: Record<NonNullable<Props["accent"]>, string> = {
  primary: "#34d3bf",
  accent: "#4aa3ff",
  ok: "#29d17e",
  warn: "#f5b13d",
  orange: "#f5803d",
  bad: "#ef4757",
}

// A 270-degree radial gauge with a polished chrome bezel and a glowing arc.
export function RadialGauge({
  value,
  min,
  max,
  label,
  unit = "",
  size = 150,
  accent = "primary",
}: Props) {
  const clamped = Math.min(Math.max(value, min), max)
  const pct = max > min ? (clamped - min) / (max - min) : 0

  const stroke = 10
  const r = (size - stroke) / 2 - 8
  const cx = size / 2
  const cy = size / 2

  // 270-degree sweep, starting at 135deg (bottom-left) going clockwise.
  const startAngle = 135
  const sweep = 270
  const circumference = 2 * Math.PI * r
  const arcLen = (sweep / 360) * circumference
  const dash = pct * arcLen
  const color = ACCENT_HEX[accent]

  // formatted number: no decimals for big values, 1-2 for small
  const abs = Math.abs(value)
  const display =
    abs >= 100 ? Math.round(value).toString() : abs >= 10 ? value.toFixed(1) : value.toFixed(2)

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative" style={{ width: size, height: size }}>
        {/* chrome bezel ring */}
        <div
          className="chrome-bezel absolute inset-0 rounded-full"
          style={{ padding: 4 }}
          aria-hidden
        >
          <div className="h-full w-full rounded-full bg-card" />
        </div>

        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="absolute inset-0"
          style={{ transform: `rotate(${startAngle}deg)` }}
          role="img"
          aria-label={`${label}: ${display} ${unit}`}
        >
          {/* track */}
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke="#1d2531"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${arcLen} ${circumference}`}
          />
          {/* value arc */}
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circumference}`}
            style={{
              filter: `drop-shadow(0 0 6px ${color}aa)`,
              transition: "stroke-dasharray 0.6s ease",
            }}
          />
        </svg>

        {/* center readout */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-foreground">
            {display}
          </span>
          {unit ? <span className="text-xs font-medium text-muted">{unit}</span> : null}
        </div>
      </div>
      <span className="max-w-[10rem] text-center text-xs font-medium text-muted-foreground">
        {label}
      </span>
    </div>
  )
}
