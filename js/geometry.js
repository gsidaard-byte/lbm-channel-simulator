// Channel geometry: parameters (mm/deg), constraints, and mask rasterization.
export const CAPS = { totalLenMM: 228.6, exitHeightMM: 203.2 }; // 9in, 8in
export const SOLID = 0, FLUID = 1, INLET = 2, OUTLET = 3;

export const DEFAULT_PARAMS = {
  d1: 12.7, d2: 15, d3: 20, d4: 20, d5: 150, d6: 25,
  theta1: 25, theta2: 15, nVanes: 6,
};

const rad = (deg) => deg * Math.PI / 180;
const deg = (r) => r * 180 / Math.PI;

export function derived(p) {
  const exitHeight = p.d4 + 2 * p.d5 * Math.tan(rad(p.theta1));
  const totalLen = p.d1 + p.d2 + p.d3 + p.d5 + p.d6;
  return { exitHeight, totalLen };
}

export function violations(p) {
  const d = derived(p), v = [];
  if (d.totalLen > CAPS.totalLenMM + 1e-9) v.push('length');
  if (d.exitHeight > CAPS.exitHeightMM + 1e-9) v.push('height');
  return v;
}

export function maxTheta1(p) {
  return deg(Math.atan((CAPS.exitHeightMM - p.d4) / (2 * p.d5)));
}

export function maxD5(p) {
  const fromLen = CAPS.totalLenMM - (p.d1 + p.d2 + p.d3 + p.d6);
  const fromH = (CAPS.exitHeightMM - p.d4) / (2 * Math.tan(rad(Math.max(p.theta1, 0.5))));
  return Math.min(fromLen, fromH);
}

// Repair a violating parameter set by shrinking theta1, then d5, then d6.
export function clampParams(p) {
  const q = { ...p };
  if (derived(q).exitHeight > CAPS.exitHeightMM)
    q.theta1 = Math.min(q.theta1, maxTheta1(q) - 1e-6);
  if (derived(q).totalLen > CAPS.totalLenMM) {
    const excess = derived(q).totalLen - CAPS.totalLenMM;
    q.d5 = Math.max(20, q.d5 - excess);
  }
  if (derived(q).totalLen > CAPS.totalLenMM)
    q.d6 = Math.max(5, q.d6 - (derived(q).totalLen - CAPS.totalLenMM));
  return q;
}
