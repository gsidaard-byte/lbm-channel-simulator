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

// Pick dt for a given dx [m] and max physical speed [m/s]:
// prefer lattice Mach cap uLat<=0.1; if that would push tau below tauMin,
// enforce tau=tauMin instead and accept a higher lattice velocity.
export function latticeParams({ dxM, uMaxPhys, tauMin = 0.51, uLatCap = 0.1 }) {
  const warnings = [];
  let dt = uLatCap * dxM / uMaxPhys;
  let tau = 3 * (NU * dt / (dxM * dxM)) + 0.5;
  if (tau < tauMin) {
    tau = tauMin;
    dt = ((tauMin - 0.5) / 3) * dxM * dxM / NU;
    warnings.push('smagorinsky-recommended');
  }
  const uLat = uMaxPhys * dt / dxM;
  if (uLat > 0.17) warnings.push('high-mach');
  return { dt, tau, uLat, warnings };
}
