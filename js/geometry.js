// Channel geometry: parameters (mm/deg), constraints, and mask rasterization.
export const CAPS = { totalLenMM: 228.6, exitHeightMM: 203.2 }; // 9in, 8in
export const SOLID = 0, FLUID = 1, INLET = 2, OUTLET = 3;

export const DEFAULT_PARAMS = {
  d1: 12.7, d2: 15, d3: 20, d4: 20, d5: 150, d6: 25,
  theta1: 25, theta2: 15, nVanes: 6,
  s0: 1, s1: 1,          // diffuser wall end-slope factors (1,1 = straight)
  vaneLen: 15,           // vane chord [mm]
  vanePos: 150,          // diffuser entrance -> vane leading edge [mm]
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
  if (q.vaneLen != null && q.vanePos != null) {
    q.vaneLen = Math.min(q.vaneLen, q.d5 + q.d6 - 2);
    q.vanePos = Math.max(0, Math.min(q.vanePos, q.d5 + q.d6 - q.vaneLen));
  }
  return q;
}

// Quintic wall-shape function: g(0)=0, g(1)=1, g''(0)=g''(1)=0, g'(0)=s0,
// g'(1)=s1 (slopes as fractions of the straight-wall slope). s0=s1=1 -> g=xi
// (straight); s0=s1=0 -> Bell-Mehta S-curve 10xi^3-15xi^4+6xi^5. Clamped to
// [0,1] so the wall never bulges past the exit height or below the throat.
function quinticG(xi, s0, s1) {
  const A = 1 - s0, B = s1 - s0;
  const c3 = 10 * A - 4 * B, c4 = 7 * B - 15 * A, c5 = 6 * A - 3 * B;
  const g = s0 * xi + c3 * xi ** 3 + c4 * xi ** 4 + c5 * xi ** 5;
  return Math.min(1, Math.max(0, g));
}

// Channel half-height at streamwise station xmm (valid from the throat on).
export function halfHeightAt(p, xmm) {
  const xd = p.d1 + p.d2 + p.d3, xe = xd + p.d5;
  const h0 = p.d4 / 2, h1 = h0 + p.d5 * Math.tan(p.theta1 * Math.PI / 180);
  if (xmm <= xd) return h0;
  if (xmm >= xe) return h1;
  return h0 + (h1 - h0) * quinticG((xmm - xd) / p.d5, p.s0 ?? 1, p.s1 ?? 1);
}

const smooth = (t) => t * t * (3 - 2 * t); // smoothstep

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-12;
  let t = ((px - ax) * dx + (py - ay) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Rasterize params to a mask grid. dxMM = cell size in mm.
// A numerical buffer of `bufferW` columns is appended after the physical exit
// plane; the solver puts a viscosity sponge there so vortices leave without
// reflecting off the outlet. meta.probeCol is the physical exit plane.
// Returns {ok, error?, mask, nx, ny, dx, yc, margin,
//          meta:{connected, exitHeight, totalLen, probeCol, bufferW}}
export function buildMask(p, dxMM, margin = 2, bufferW = 18) {
  const bad = violations(p);
  if (bad.length) return { ok: false, error: `constraint violated: ${bad.join(', ')}` };
  const der = derived(p);
  const H = Math.max(der.exitHeight + 2 * margin * dxMM, 2 * (p.d4 / 2 + p.d2 + 10));
  const nx = Math.ceil(der.totalLen / dxMM) + margin + bufferW;
  const ny = Math.ceil(H / dxMM);
  const yc = (ny * dxMM) / 2;
  const Cy = yc - p.d4 / 2 - p.d2;      // duct bottom / turn center y
  if (Cy < 2 * dxMM) return { ok: false, error: 'duct does not fit (increase exit height or reduce d2/d4)' };
  const Cx = p.d1 + p.d2;
  const xt = p.d1 + p.d2, xd = xt + p.d3, xe = xd + p.d5, xEnd = xe + p.d6;
  const th2 = p.theta2 * Math.PI / 180;
  const N = p.nVanes | 0;
  const Lv = p.vaneLen ?? Math.min(0.8 * p.d6, 15), halfC = Lv / 2;
  const vaneTh = Math.max(1.0, 2.2 * dxMM) / 2;
  // vane leading edge sits vanePos downstream of the diffuser entrance,
  // clamped so the vane fits inside diffuser + exit section
  const dv = Math.max(0, Math.min(p.vanePos ?? p.d5, p.d5 + p.d6 - Lv));
  const xv = xd + dv + halfC * Math.cos(th2);   // vane center station
  const Hloc = halfHeightAt(p, xv);             // local channel half-height there
  const vanes = [];
  for (let j = 1; j <= N; j++) {
    const o = 2 * Hloc * (j / (N + 1) - 0.5);
    const dirY = Math.sign(o) * Math.sin(th2), dirX = Math.cos(th2);
    vanes.push([xv - halfC * dirX, yc + o - halfC * dirY, xv + halfC * dirX, yc + o + halfC * dirY]);
  }

  const isFluid = (x, y) => {
    if (x >= 0 && x <= p.d1 && y >= 0 && y <= Cy) return true;                    // duct
    if (x <= Cx && y >= Cy) {                                                     // turn
      const r = Math.hypot(x - Cx, y - Cy);
      const a = Math.atan2(y - Cy, Cx - x) / (Math.PI / 2);                       // 0=duct side, 1=throat side
      if (a >= 0 && a <= 1) {
        const ro = (p.d1 + p.d2) + smooth(a) * ((p.d2 + p.d4) - (p.d1 + p.d2));
        if (r >= p.d2 && r <= ro) return true;
      }
    }
    const dy = Math.abs(y - yc);
    if (x >= xt && x <= xd && dy <= p.d4 / 2) return true;                        // throat
    if (x >= xd && x <= xe && dy <= halfHeightAt(p, x)) return true;              // diffuser (quintic wall)
    if (x >= xe && x <= xEnd + (bufferW + 2) * dxMM && dy <= der.exitHeight / 2)
      return true;                                                                // exit + numerical buffer
    return false;
  };

  const mask = new Uint8Array(nx * ny); // SOLID
  for (let gy = 0; gy < ny; gy++) {
    const ymm = (gy + 0.5) * dxMM;
    for (let gx = 0; gx < nx; gx++) {
      const xmm = (gx + 0.5) * dxMM - margin * dxMM;
      if (!isFluid(xmm, ymm)) continue;
      let solid = false;
      for (const [ax, ay, bx, by] of vanes)
        if (distToSeg(xmm, ymm, ax, ay, bx, by) <= vaneTh) { solid = true; break; }
      mask[gy * nx + gx] = solid ? SOLID : FLUID;
    }
  }
  // inlet: top row fluid cells (duct opening); outlet: rightmost fluid column
  for (let gx = 0; gx < nx; gx++) if (mask[gx] === FLUID) mask[gx] = INLET;
  for (let gy = 0; gy < ny; gy++) {
    const i = gy * nx + (nx - 1);
    if (mask[i] === FLUID) mask[i] = OUTLET;
  }
  // BFS connectivity from inlet to outlet
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
  const probeCol = Math.min(nx - 3, margin + Math.round(der.totalLen / dxMM) - 1);
  return { ok: true, mask, nx, ny, dx: dxMM, yc, margin,
           meta: { connected, exitHeight: der.exitHeight, totalLen: der.totalLen,
                   probeCol, bufferW } };
}
