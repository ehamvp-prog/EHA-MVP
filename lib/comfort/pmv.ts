// Typed wrapper around jsthermalcomfort's ASHRAE PMV/PPD model. Every other
// module imports the model through THIS single wrapper so the dependency
// surface stays in one place and the return shape is normalized to numbers.
import { pmv_ppd_ashrae as _pmv_ppd_ashrae } from "jsthermalcomfort"

export type PmvPpd = { pmv: number; ppd: number; tsv?: number }

export function pmvPpdAshrae(
  tdb: number,
  tr: number,
  vr: number,
  rh: number,
  met: number,
  clo: number,
  wme = 0,
  options: { units?: "SI" | "IP" } = { units: "SI" },
): PmvPpd {
  const r = _pmv_ppd_ashrae(tdb, tr, vr, rh, met, clo, wme, options) as PmvPpd
  return { pmv: Number(r.pmv), ppd: Number(r.ppd) }
}
