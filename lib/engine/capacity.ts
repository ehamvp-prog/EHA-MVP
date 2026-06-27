// =====================================================================
// Cooling capacity from DRY-AIR mass flow and the return->supply
// enthalpy difference. Unit-consistent: enthalpy is per lb DRY air, so
// mass flow must also be DRY-air mass flow.
//
//   Q_total (BTU/hr) = m_da (lb_da/hr) * (h_return - h_supply) (BTU/lb_da)
//
// Dry-air mass flow from volumetric airflow:
//   m_da (lb_da/hr) = CFM (ft^3/min) * 60 (min/hr) / v (ft^3/lb_da)
//
// We use the RETURN-side specific volume because CFM is the air entering
// the coil (return side). This is documented and consistent.
// =====================================================================

import type { MoistAirState } from "./psychrometrics"

export interface CapacityResult {
  capacityBtuh: number | null
  dryAirMassFlowLbHr: number | null
}

export function capacityFromAirSide(
  cfm: number | null,
  returnState: MoistAirState | null,
  supplyState: MoistAirState | null,
): CapacityResult {
  if (
    cfm == null ||
    !Number.isFinite(cfm) ||
    cfm <= 0 ||
    returnState == null ||
    supplyState == null
  ) {
    return { capacityBtuh: null, dryAirMassFlowLbHr: null }
  }

  // Dry-air mass flow using return-side specific volume (entering air).
  const mDa = (cfm * 60) / returnState.specificVolume // lb dry air / hr

  // Cooling removes heat: return enthalpy > supply enthalpy.
  const dh = returnState.enthalpy - supplyState.enthalpy // BTU / lb_da
  const q = mDa * dh // BTU/hr

  return { capacityBtuh: q, dryAirMassFlowLbHr: mDa }
}
