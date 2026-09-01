// Physical <-> lattice unit conversions. Water at room temperature.
export const RHO = 1000;      // kg/m^3
export const NU = 1.0e-6;     // m^2/s

// Flow-meter calibration (FlowRatevsFrequency.png): linear fit through
// (6 Hz, 2.3e-3 kg/s) and (42 Hz, 11.5e-3 kg/s).
const CAL_SLOPE = (11.5e-3 - 2.3e-3) / (42 - 6);
const CAL_INTERCEPT = 2.3e-3 - CAL_SLOPE * 6;
export const MDOT_MIN = 2.3e-3, MDOT_MAX = 11.5e-3;

export function hzFromMdot(mdot) { return (mdot - CAL_INTERCEPT) / CAL_SLOPE; }
export function mdotFromHz(hz) { return CAL_SLOPE * hz + CAL_INTERCEPT; }

// mdot [kg/s], d1 and depth [m] -> mean inlet velocity [m/s]
export function inletVelocity(mdot, d1M, depthM) { return mdot / (RHO * d1M * depthM); }

// By continuity U_throat*d4 = U_in*d1, so Re_throat = U_throat*d4/nu = U_in*d1/nu.
export function throatReynolds(uInlet, d1M) { return uInlet * d1M / NU; }

// Pick lattice parameters for a given dx [m] and max physical speed [m/s].
// dt is Mach-set (uLat = uLatCap exactly). Stability requires the cell
// Reynolds number uLat/nuLat <= cellReMax (measured empirically on this
// geometry); when the physical viscosity would exceed that, viscosity is
// inflated and the simulation runs at a reduced effective Reynolds number
// reEff = rePhys * reScale, flagged with the 'reynolds-capped' warning.
export function latticeParams({ dxM, uMaxPhys, uLatCap = 0.08, cellReMax = 6 }) {
  const warnings = [];
  const dt = uLatCap * dxM / uMaxPhys;
  const nuLatPhys = NU * dt / (dxM * dxM);
  let nuLat = nuLatPhys;
  if (uLatCap / nuLat > cellReMax) {
    nuLat = uLatCap / cellReMax;
    warnings.push('reynolds-capped');
  }
  const tau = 3 * nuLat + 0.5;
  return { dt, tau, uLat: uLatCap, reScale: nuLatPhys / nuLat, warnings };
}
