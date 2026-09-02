// Coat-hanger (manifold) distributor: no diffuser, no jet. The inlet duct
// runs to mid-height, feeds the CENTER of a vertical tapered header that
// spans the full exit height; flow bleeds through a high-resistance fitted
// slot plate (the "land") into a settling chamber and out the exit.
// Uniformity comes from the header taper + land resistance, not turbulence.
// Fixed 12.7mm inlet, fixed 203.2mm exit, fixed 228.6mm length.
import { CAPS, SOLID, FLUID, INLET, OUTLET, smooth } from './geometry.js';

const D1 = 12.7;

export const CH_DEFAULTS = {
  wt: 16,          // transport duct width [mm]
  bend: 10,        // bend fillet radius [mm]
  xh: 190,         // header plane (land plate x) [mm]
  w0: 18,          // header width at center (feed) [mm]
  w1: 3,           // header width at the tips [mm]
  taperP: 1,       // taper exponent: w = w1 + (w0-w1)*(1-eta)^taperP
  landS: 0.87,     // land solidity (high: resistance dominates header dp)
  landG: 2.5,      // land slot width [mm]
  sp_s: 0.3,       // optional settling plate solidity (0 = off)
  sp_x: 12,        // settling plate offset downstream of the land [mm]
  sp_g: 4,         // settling plate slot width [mm]
  bafH: 0,         // impingement baffle: blank the land over this height at
                   // the centerline so the feed turns into the arms (0 = off)
};

export function chClamp(p) {
  const q = { ...CH_DEFAULTS, ...p };
  q.wt = Math.min(24, Math.max(10, q.wt));
  q.bend = Math.min(15, Math.max(6, q.bend));
  q.w0 = Math.min(30, Math.max(8, q.w0));
  q.w1 = Math.min(Math.min(8, q.w0 - 1), Math.max(2, q.w1));
  q.taperP = Math.min(3, Math.max(0.3, q.taperP));
  q.xh = Math.min(CAPS.totalLenMM - 22, Math.max(D1 + q.bend + q.w0 + 30, q.xh));
  q.landS = Math.min(0.92, Math.max(0.6, q.landS));
  q.landG = Math.min(5, Math.max(2, q.landG));
  q.sp_s = Math.min(0.6, Math.max(0, q.sp_s));
  q.sp_x = Math.min(CAPS.totalLenMM - q.xh - 10, Math.max(5, q.sp_x));
  q.sp_g = Math.min(8, Math.max(2, q.sp_g));
  q.bafH = Math.min(80, Math.max(0, q.bafH));
  return q;
}

// fitted uniform slot pattern across the exit span; returns true for rib
function ribAt(ymm, yc, H2, gap, sol) {
  const span = 2 * H2;
  const pitch0 = gap / Math.max(0.1, 1 - sol);
  const n = Math.max(2, Math.round(span / pitch0));
  const pitch = span / n, gapFit = pitch * (1 - sol);
  const rel = (ymm - (yc - H2)) / pitch;
  const frac = Math.abs(rel - Math.floor(rel) - 0.5) * pitch;
  return frac > gapFit / 2;
}

export function buildMaskCoathanger(params, dxMM, margin = 2, bufferW = 18) {
  const p = chClamp(params);
  const H2 = CAPS.exitHeightMM / 2, xEnd = CAPS.totalLenMM;
  const H = CAPS.exitHeightMM + 2 * margin * dxMM;
  const nx = Math.ceil(xEnd / dxMM) + margin + bufferW;
  const ny = Math.ceil(H / dxMM);
  const yc = (ny * dxMM) / 2;
  const Cy = yc - p.wt / 2 - p.bend, Cx = D1 + p.bend;
  if (Cy < 2 * dxMM) return { ok: false, error: 'transport duct does not fit' };
  const roTurn = (a) => (D1 + p.bend) + smooth(a) * ((p.bend + p.wt) - (D1 + p.bend));
  const headerW = (ymm) => {
    const eta = Math.min(1, Math.abs(ymm - yc) / H2);
    return p.w1 + (p.w0 - p.w1) * Math.pow(1 - eta, p.taperP);
  };
  const plateTh = Math.max(2, 2 * dxMM);
  const landAsPlate = p.landG >= 2.5 * dxMM;
  const spOn = p.sp_s > 0, spAsPlate = p.sp_g >= 2.5 * dxMM;
  const xSp = p.xh + plateTh + p.sp_x;

  const isFluid = (x, y) => {
    if (x >= 0 && x <= D1 && y >= 0 && y <= Cy) return true;                 // inlet duct
    if (x <= Cx && y >= Cy) {                                                // bend
      const r = Math.hypot(x - Cx, y - Cy);
      const a = Math.atan2(y - Cy, Cx - x) / (Math.PI / 2);
      if (a >= 0 && a <= 1 && r >= p.bend && r <= roTurn(a)) return true;
    }
    const dy = Math.abs(y - yc);
    if (x >= Cx && x <= p.xh - p.w0 && dy <= p.wt / 2) return true;          // transport duct
    if (x >= p.xh - headerW(y) && x <= p.xh && dy <= H2) return true;        // tapered header
    if (x >= p.xh && x <= xEnd + (bufferW + 2) * dxMM && dy <= H2) return true; // settling + buffer
    return false;
  };

  const mask = new Uint8Array(nx * ny);
  const porous = new Float32Array(nx * ny);
  for (let gy = 0; gy < ny; gy++) {
    const ymm = (gy + 0.5) * dxMM;
    for (let gx = 0; gx < nx; gx++) {
      const xmm = (gx + 0.5) * dxMM - margin * dxMM;
      if (!isFluid(xmm, ymm)) continue;
      const c = gy * nx + gx;
      mask[c] = FLUID;
      if (xmm >= p.xh && xmm < p.xh + plateTh) {                             // land
        if (p.bafH > 0 && Math.abs(ymm - yc) <= p.bafH / 2) mask[c] = SOLID; // baffle
        else if (landAsPlate) { if (ribAt(ymm, yc, H2, p.landG, p.landS)) mask[c] = SOLID; }
        else porous[c] = p.landS;
      } else if (spOn && xmm >= xSp && xmm < xSp + plateTh) {                // settling plate
        if (spAsPlate) { if (ribAt(ymm + 1.7, yc, H2, p.sp_g, p.sp_s)) mask[c] = SOLID; }
        else porous[c] = p.sp_s;
      }
    }
  }
  for (let gx = 0; gx < nx; gx++) if (mask[gx] === FLUID) mask[gx] = INLET;
  for (let gy = 0; gy < ny; gy++) {
    const i = gy * nx + (nx - 1);
    if (mask[i] === FLUID) mask[i] = OUTLET;
  }
  const seen = new Uint8Array(nx * ny), q = [];
  for (let gx = 0; gx < nx; gx++) if (mask[gx] === INLET) { q.push(gx); seen[gx] = 1; }
  let connected = false;
  while (q.length) {
    const i = q.pop(), gx = i % nx, gy = (i / nx) | 0;
    if (mask[i] === OUTLET) { connected = true; break; }
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const tx = gx + ox, ty = gy + oy;
      if (tx < 0 || tx >= nx || ty < 0 || ty >= ny) continue;
      const j = ty * nx + tx;
      if (!seen[j] && mask[j] !== SOLID) { seen[j] = 1; q.push(j); }
    }
  }
  const probeCol = Math.min(nx - 3, margin + Math.round(xEnd / dxMM) - 1);
  return { ok: true, mask, porous, nx, ny, dx: dxMM, yc, margin,
           meta: { connected, exitHeight: CAPS.exitHeightMM, totalLen: CAPS.totalLenMM,
                   probeCol, bufferW, design: 'coathanger' } };
}
