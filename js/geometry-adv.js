// Advanced flow-conditioning geometry: fixed 12.7mm inlet, fixed 203.2mm exit,
// fixed 228.6mm length. Uniformity comes from flow splitting + resistance:
// bend turning vanes, quintic expansion, auto-cambered splitter-vane rows,
// and porous screens (perforated-plate analog).
import { CAPS, SOLID, FLUID, INLET, OUTLET, smooth, distToSeg, quinticG } from './geometry.js';

export const ADV_DEFAULTS = {
  th: 20,                  // throat height [mm]
  tl: 15,                  // throat length [mm]
  Lexp: 120,               // expansion length [mm]; rest is settling/exit
  s0: 0.5, s1: 0.5,        // quintic wall end-slope factors
  bendVanes: 2,            // turning vanes in the 90-degree bend (0-4)
  r1n: 4, r1x: 25, r1c: 25,   // splitter row 1: count, LE pos from expansion entry, chord
  r2n: 8, r2x: 70, r2c: 25,   // splitter row 2
  sc1x: 150, sc1s: 0.6,    // screen 1: pos from expansion entry, solidity (0 = off)
  sc2x: 175, sc2s: 0.4,    // screen 2
  scrMode: 'plate',        // 'plate' = 3D-printable rib array; 'porous' = ideal mesh
  sc1g: 3, sc2g: 3,        // plate slot (gap) widths [mm]
  sc2fit: true,            // screen 2: fit an integer number of equal slots
                           // wall-to-wall (half-ribs attach to both walls)
  // near-throat conditioning plates (screen ladder), off by default:
  sc3x: 8, sc3s: 0, sc3g: 3,     // just after the throat
  sc4x: 55, sc4s: 0, sc4g: 4,    // mid-expansion
  // feed style: 'bend' (single 90-degree turn) or 'serp' (down, U-turn, up -
  // the two opposing turns cancel the inlet's Coanda bias)
  feed: 'bend',
  serpDrop: 45,                  // U-turn depth below the centerline [mm]
  serpR: 6, serpR2: 8,           // U-turn / recovery-turn fillet radii [mm]
  // slotted V-chevron distributor inside the expansion (0 = off):
  vRows: 0,                      // 1 = one V pair, 2 = nested pair
  vAx: 22,                       // apex position from the expansion entrance [mm]
  vTx: 108,                      // arm tip station [mm]
  vTyF: 0.72,                    // tip height as a fraction of local half-height
  vS: 0.6,                       // solid fraction along the arm (slotted)
  vP: 12,                        // slot pitch along the arm [mm]
  vNest: 22,                     // apex offset of the nested inner V [mm]
};

const D1 = 12.7, D2 = 15;  // inlet width and bend length (fixed hardware)

export function advClamp(p) {
  const q = { ...ADV_DEFAULTS, ...p };
  q.th = Math.min(40, Math.max(8, q.th));
  q.tl = Math.min(40, Math.max(5, q.tl));
  q.feed = q.feed === 'serp' ? 'serp' : 'bend';
  q.serpDrop = Math.min(75, Math.max(20, q.serpDrop ?? 45));
  q.serpR = Math.min(10, Math.max(4, q.serpR ?? 6));
  q.serpR2 = Math.min(14, Math.max(6, q.serpR2 ?? 8));
  q.vRows = Math.min(2, Math.max(0, Math.round(q.vRows ?? 0)));
  q.vAx = Math.min(80, Math.max(5, q.vAx ?? 22));
  q.vTx = Math.min(190, Math.max(q.vAx + 30, q.vTx ?? 108));
  q.vTyF = Math.min(0.9, Math.max(0.3, q.vTyF ?? 0.72));
  q.vS = Math.min(0.9, Math.max(0.2, q.vS ?? 0.6));
  q.vP = Math.min(25, Math.max(6, q.vP ?? 12));
  q.vNest = Math.min(40, Math.max(8, q.vNest ?? 22));
  const feedLen = q.feed === 'serp' ? 2 * D1 + 2 * q.serpR + q.serpR2 : D1 + D2;
  const budget = CAPS.totalLenMM - (feedLen + q.tl);
  q.Lexp = Math.min(budget - 12, Math.max(50, q.Lexp));
  const span = budget;                        // vanes/screens live in expansion+exit
  for (const [xk, ck] of [['r1x', 'r1c'], ['r2x', 'r2c']]) {
    q[ck] = Math.min(60, Math.max(8, q[ck]));
    q[xk] = Math.min(span - q[ck] - 3, Math.max(3, q[xk]));
  }
  for (const k of ['sc1x', 'sc2x', 'sc3x', 'sc4x']) q[k] = Math.min(span - 8, Math.max(3, q[k]));
  for (const k of ['sc1s', 'sc2s', 'sc3s', 'sc4s']) q[k] = Math.min(0.9, Math.max(0, q[k]));
  for (const k of ['sc1g', 'sc2g', 'sc3g', 'sc4g']) q[k] = Math.min(8, Math.max(2, q[k]));
  if (q.scrMode !== 'porous') q.scrMode = 'plate';
  q.sc2fit = q.sc2fit !== false;
  q.bendVanes = Math.min(4, Math.max(0, Math.round(q.bendVanes)));
  q.r1n = Math.min(12, Math.max(0, Math.round(q.r1n)));
  q.r2n = Math.min(16, Math.max(0, Math.round(q.r2n)));
  for (const k of ['s0', 's1']) q[k] = Math.min(1.5, Math.max(0, q[k]));
  return q;
}

// Rasterize. Returns {ok, error?, mask, porous, nx, ny, dx, yc, margin,
//   meta:{connected, exitHeight, totalLen, probeCol, bufferW, throatH}}
export function buildMaskAdvanced(params, dxMM, margin = 2, bufferW = 18) {
  const p = advClamp(params);
  const H2 = CAPS.exitHeightMM / 2, h0 = p.th / 2;
  const serp = p.feed === 'serp';
  const uR = p.serpR, r2b = p.serpR2;
  const xt = serp ? 2 * D1 + 2 * uR + r2b : D1 + D2;
  const xd = xt + p.tl, xe = xd + p.Lexp, xEnd = CAPS.totalLenMM;
  const H = Math.max(CAPS.exitHeightMM + 2 * margin * dxMM,
    2 * (h0 + D2 + 10),
    serp ? 2 * (p.serpDrop + uR + D1 + 3) : 0);
  const nx = Math.ceil(xEnd / dxMM) + margin + bufferW;
  const ny = Math.ceil(H / dxMM);
  const yc = (ny * dxMM) / 2;
  const Cy = yc - h0 - D2, Cx = xt;
  if (Cy < 2 * dxMM) return { ok: false, error: 'duct does not fit' };

  // channel half-height from the throat on
  const hAt = (x) => x <= xd ? h0
    : x >= xe ? H2
    : h0 + (H2 - h0) * quinticG((x - xd) / p.Lexp, p.s0, p.s1);
  const roTurn = (a) => (D1 + D2) + smooth(a) * ((D2 + p.th) - (D1 + D2));

  // --- vane polylines (bend arcs + auto-cambered splitter rows) ---
  const vaneTh = Math.max(1.0, 2.2 * dxMM) / 2;
  const polys = [];                     // each: {pts: [[x,y]...], bb: [x0,y0,x1,y1]}
  const addPoly = (pts) => {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    polys.push({ pts, bb: [x0, y0, x1, y1] });
  };
  // raster feasibility: cap vane counts so passages stay >= ~3.5 cells wide
  // (narrower passages both under-resolve the flow and accelerate it past the
  // stable lattice velocity)
  const maxCount = (width) => Math.max(0, Math.floor(width / (3.5 * dxMM + 2 * vaneTh)) - 1);
  const nBend = serp ? 0 : Math.min(p.bendVanes, maxCount(p.th));
  for (let k = 1; k <= nBend; k++) {                // concentric bend arcs
    const fk = k / (nBend + 1), pts = [];
    for (let m = 0; m <= 14; m++) {
      const phi = 0.12 + (m / 14) * (Math.PI / 2 - 0.24);
      const r = D2 + fk * (roTurn(phi / (Math.PI / 2)) - D2);
      pts.push([Cx - r * Math.cos(phi), Cy + r * Math.sin(phi)]);
    }
    addPoly(pts);
  }
  // splitter rows: LE aligned with ray from the expansion's virtual apex, TE axial
  const apex = h0 * p.Lexp / (H2 - h0);             // apex distance upstream of xd
  for (const [n0, rx, chord] of [[p.r1n, p.r1x, p.r1c], [p.r2n, p.r2x, p.r2c]]) {
    const x0 = xd + rx, hLE = hAt(x0);
    const n = Math.min(n0, maxCount(2 * hLE));
    if (n <= 0) continue;
    for (let j = 1; j <= n; j++) {
      const o = 2 * hLE * (j / (n + 1) - 0.5);
      const beta = Math.atan(o / (rx + apex));
      const pts = [[x0, yc + o]];
      for (let m = 1; m <= 8; m++) {
        const phi = beta * (1 - (m - 0.5) / 8);
        const [px, py] = pts[m - 1];
        pts.push([px + (chord / 8) * Math.cos(phi), py + (chord / 8) * Math.sin(phi)]);
      }
      addPoly(pts);
    }
  }
  // slotted V-chevron distributor: mirrored curved arms from a centerline apex
  // sweeping outward toward the exit corners; slotted along their arc length
  // (solid fraction vS at pitch vP) so pressure equalizes across passages.
  if ((p.vRows | 0) > 0) {
    const addSlottedCurve = (P0, P1, P2) => {
      const N = 72, pts = [];
      for (let i = 0; i <= N; i++) {
        const t = i / N, u = 1 - t;
        pts.push([u * u * P0[0] + 2 * u * t * P1[0] + t * t * P2[0],
                  u * u * P0[1] + 2 * u * t * P1[1] + t * t * P2[1]]);
      }
      let s = 0, cur = [pts[0]];
      for (let i = 1; i <= N; i++) {
        s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        if ((s % p.vP) < p.vS * p.vP) cur.push(pts[i]);
        else { if (cur.length > 1) addPoly(cur); cur = [pts[i]]; }
      }
      if (cur.length > 1) addPoly(cur);
    };
    const mkV = (ax, tx, tyF) => {
      const x0 = xd + ax, x1 = Math.min(xd + tx, xEnd - 6);
      const ty = tyF * hAt(x1);
      for (const sgn of [1, -1]) {
        addSlottedCurve([x0, yc],
          [x0 + 0.55 * (x1 - x0), yc + sgn * 0.22 * ty],
          [x1, yc + sgn * ty]);
      }
    };
    mkV(p.vAx, p.vTx, p.vTyF);
    if ((p.vRows | 0) >= 2) mkV(p.vAx + p.vNest, p.vTx - 8, p.vTyF * 0.55);
  }
  const nearVane = (x, y) => {
    for (const { pts, bb } of polys) {
      if (x < bb[0] - vaneTh || x > bb[2] + vaneTh || y < bb[1] - vaneTh || y > bb[3] + vaneTh) continue;
      for (let m = 0; m + 1 < pts.length; m++)
        if (distToSeg(x, y, pts[m][0], pts[m][1], pts[m + 1][0], pts[m + 1][1]) <= vaneTh) return true;
    }
    return false;
  };

  // serpentine feed geometry (down leg -> U-turn -> up leg -> turn into throat)
  const yU = yc + p.serpDrop;
  const C1x = D1 + uR, x2a = D1 + 2 * uR;
  const C2x = x2a + D1 + r2b, C2y = yc + h0 + r2b;
  const roTurn2 = (a) => (D1 + r2b) + smooth(a) * ((r2b + p.th) - (D1 + r2b));

  const isFluid = (x, y) => {
    if (serp) {
      if (x >= 0 && x <= D1 && y >= 0 && y <= yU) return true;                  // down leg
      if (y >= yU) {                                                            // U-turn
        const r = Math.hypot(x - C1x, y - yU);
        if (r >= uR && r <= uR + D1) return true;
      }
      if (x >= x2a && x <= x2a + D1 && y >= C2y && y <= yU) return true;        // up leg
      if (x <= C2x && y <= C2y && y >= yc - h0 - 2) {                           // turn to throat
        const r = Math.hypot(x - C2x, y - C2y);
        const a = Math.atan2(C2y - y, C2x - x) / (Math.PI / 2);
        if (a >= 0 && a <= 1 && r >= r2b && r <= roTurn2(a)) return true;
      }
    } else {
      if (x >= 0 && x <= D1 && y >= 0 && y <= Cy) return true;                  // duct
      if (x <= Cx && y >= Cy) {                                                 // bend
        const r = Math.hypot(x - Cx, y - Cy);
        const a = Math.atan2(y - Cy, Cx - x) / (Math.PI / 2);
        if (a >= 0 && a <= 1 && r >= D2 && r <= roTurn(a)) return true;
      }
    }
    const dy = Math.abs(y - yc);
    if (x >= xt && x <= xe && dy <= hAt(x)) return true;                        // throat + expansion
    if (x >= xe && x <= xEnd + (bufferW + 2) * dxMM && dy <= H2) return true;   // exit + buffer
    return false;
  };

  const mask = new Uint8Array(nx * ny);
  const porous = new Float32Array(nx * ny);
  // Screens: 'plate' = resolved rib array (printable; second plate staggered
  // half a pitch); falls back to porous cells when slots would be < ~2.5 cells.
  const plateTh = Math.max(2, 2 * dxMM);
  const screens = [
    { xs: xd + p.sc1x, sol: p.sc1s, gap: p.sc1g, phase: 0, fit: false },
    { xs: xd + p.sc2x, sol: p.sc2s, gap: p.sc2g, phase: 0.5, fit: p.sc2fit },
    { xs: xd + p.sc3x, sol: p.sc3s ?? 0, gap: p.sc3g ?? 3, phase: 0.25, fit: false },
    { xs: xd + p.sc4x, sol: p.sc4s ?? 0, gap: p.sc4g ?? 4, phase: 0.75, fit: false },
  ].filter(s => s.sol > 0).map(s => {
    const out = { ...s, asPlate: p.scrMode === 'plate' && s.gap >= 2.5 * dxMM && s.sol > 0.05,
                  pitch: s.gap / Math.max(0.1, 1 - s.sol) };
    if (out.fit && out.asPlate) {
      // integer number of equal slots across the local span, half-ribs at walls
      const span = 2 * hAt(out.xs + plateTh / 2);
      const n = Math.max(2, Math.round(span / out.pitch));
      out.pitch = span / n;
      out.gap = out.pitch * (1 - Math.max(0.1, out.sol));
      out.span = span;
    }
    return out;
  });
  for (let gy = 0; gy < ny; gy++) {
    const ymm = (gy + 0.5) * dxMM;
    for (let gx = 0; gx < nx; gx++) {
      const xmm = (gx + 0.5) * dxMM - margin * dxMM;
      if (!isFluid(xmm, ymm)) continue;
      const c = gy * nx + gx;
      if (nearVane(xmm, ymm)) { mask[c] = SOLID; continue; }
      mask[c] = FLUID;
      for (const s of screens) {
        if (s.asPlate) {
          if (xmm >= s.xs && xmm < s.xs + plateTh) {
            if (s.fit) {
              // wall-anchored: slot centers at (m+0.5)*pitch from the lower wall
              const rel = (ymm - (yc - s.span / 2)) / s.pitch;
              const frac = Math.abs(rel - Math.floor(rel) - 0.5) * s.pitch;
              if (frac > s.gap / 2) mask[c] = SOLID;               // rib
            } else {
              const rel = (ymm - yc) / s.pitch + s.phase;
              const frac = Math.abs(rel - Math.round(rel)) * s.pitch;
              if (frac <= (s.pitch - s.gap) / 2) mask[c] = SOLID;  // rib
            }
          }
        } else if (xmm >= s.xs && xmm < s.xs + 2 * dxMM) {
          porous[c] = s.sol;
        }
      }
    }
  }
  for (let gx = 0; gx < nx; gx++) if (mask[gx] === FLUID) mask[gx] = INLET;
  for (let gy = 0; gy < ny; gy++) {
    const i = gy * nx + (nx - 1);
    if (mask[i] === FLUID) mask[i] = OUTLET;
  }
  // BFS connectivity (porous cells are fluid)
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
                   probeCol, bufferW, throatH: p.th } };
}
