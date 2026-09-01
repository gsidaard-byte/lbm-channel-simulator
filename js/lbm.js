// D2Q9 TRT lattice Boltzmann solver. Grid: x = column, y = row (top-down).
import { SOLID, FLUID, INLET, OUTLET } from './geometry.js';

export const W = [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36];
export const CX = [0, 1, 0, -1, 0, 1, -1, -1, 1];
export const CY = [0, 0, 1, 0, -1, 1, 1, -1, -1];
export const OPP = [0, 3, 4, 1, 2, 7, 8, 5, 6];

export function feq(i, rho, ux, uy) {
  const cu = CX[i] * ux + CY[i] * uy, u2 = ux * ux + uy * uy;
  return W[i] * rho * (1 + 3 * cu + 4.5 * cu * cu - 1.5 * u2);
}

export class LBM {
  // {nx, ny, mask, tau, uIn (lattice, +y at inlet), magic=0.25, smagorinsky=0,
  //  periodic=false, ramp=0 (steps over which the inlet velocity ramps up),
  //  probeCol=nx-2 (column for exitProfile/outlet flux),
  //  spongeW=0 (columns before the outlet where tau ramps to spongeTau)}
  constructor({ nx, ny, mask, tau, uIn, magic = 0.25, smagorinsky = 0, periodic = false,
                ramp = 0, probeCol = null, spongeW = 0, spongeTau = 1.6, porous = null }) {
    this.nx = nx; this.ny = ny; this.mask = mask;
    this.porous = porous;   // per-cell screen solidity in [0,1), or null
    this.tau = tau; this.uIn = uIn; this.smag = smagorinsky; this.periodic = periodic;
    this.ramp = ramp;
    this.probeCol = probeCol ?? nx - 2;
    this.omP = 1 / tau;
    this.omM = 1 / (0.5 + magic / (tau - 0.5));
    // per-column relaxation rates: uniform except a viscosity sponge before the outlet
    this.colOmP = new Float64Array(nx).fill(this.omP);
    this.colOmM = new Float64Array(nx).fill(this.omM);
    if (spongeW > 0) {
      for (let x = nx - spongeW; x < nx; x++) {
        const t = (x - (nx - spongeW)) / spongeW;
        const tl = tau + (spongeTau - tau) * t * t;
        this.colOmP[x] = 1 / tl;
        this.colOmM[x] = 1 / (0.5 + magic / (tl - 0.5));
      }
    }
    this.f = new Float64Array(nx * ny * 9);
    this.g = new Float64Array(nx * ny * 9);
    this.steps = 0;
    // running time-averages at the probe plane (the flow is quasi-periodic:
    // the jet flaps in the wide diffuser, so instantaneous profiles oscillate).
    // Volume flux (sum u) monitors the pump; MASS flux (sum rho*u) is the
    // conserved quantity — they differ by the pressure drop across screens.
    this.avgU = new Float64Array(ny);
    this.avgInVol = 0; this.avgInMass = 0; this.avgOutMass = 0; this.avgCount = 0;
    this.inletCells = []; this.outletCells = [];
    for (let i = 0; i < nx * ny; i++) {
      if (mask[i] === INLET) this.inletCells.push(i);
      if (mask[i] === OUTLET) this.outletCells.push(i);
    }
    this.initEquilibrium();
  }

  initEquilibrium(rhoFn, uFn) {
    const { nx, ny, f } = this;
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const c = (y * nx + x) * 9;
      const rho = rhoFn ? rhoFn(x, y) : 1;
      const [ux, uy] = uFn ? uFn(x, y) : [0, 0];
      for (let i = 0; i < 9; i++) f[c + i] = feq(i, rho, ux, uy);
    }
    this.g.set(this.f);
  }

  step(n = 1) { for (let s = 0; s < n; s++) this._step(); return this.steps; }

  _step() {
    const { nx, ny, mask, f, g, periodic, smag, tau, colOmP, colOmM, porous } = this;
    const fe = new Float64Array(9), pb = new Float64Array(9);
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const c = y * nx + x;
      if (mask[c] === SOLID) continue;
      const b = c * 9;
      let rho = 0, mx = 0, my = 0;
      for (let i = 0; i < 9; i++) { const fi = f[b + i]; rho += fi; mx += fi * CX[i]; my += fi * CY[i]; }
      const ux = mx / rho, uy = my / rho;
      for (let i = 0; i < 9; i++) fe[i] = feq(i, rho, ux, uy);
      let oP = colOmP[x], oM = colOmM[x];
      if (smag > 0) { // Smagorinsky: raise effective tau from non-equilibrium stress
        let pxx = 0, pyy = 0, pxy = 0;
        for (let i = 0; i < 9; i++) {
          const fn = f[b + i] - fe[i];
          pxx += fn * CX[i] * CX[i]; pyy += fn * CY[i] * CY[i]; pxy += fn * CX[i] * CY[i];
        }
        const Q = Math.sqrt(pxx * pxx + pyy * pyy + 2 * pxy * pxy);
        const tEff = 0.5 * (tau + Math.sqrt(tau * tau + 18 * Math.SQRT2 * smag * smag * Q / rho));
        oP = 1 / tEff; oM = 1 / (0.5 + 0.25 / (tEff - 0.5));
      }
      const sig = porous ? porous[c] : 0;
      if (sig > 0) for (let i = 0; i < 9; i++) {  // precompute post for screen blend
        const j = OPP[i];
        pb[i] = f[b + i]
          - oP * (0.5 * (f[b + i] + f[b + j]) - 0.5 * (fe[i] + fe[j]))
          - oM * (0.5 * (f[b + i] - f[b + j]) - 0.5 * (fe[i] - fe[j]));
      }
      for (let i = 0; i < 9; i++) {
        const j = OPP[i];
        let post;
        if (sig > 0) {
          // partial bounce-back (Walsh): blend with the opposite direction
          post = (1 - sig) * pb[i] + sig * pb[j];
        } else {
          const fp = 0.5 * (f[b + i] + f[b + j]) - 0.5 * (fe[i] + fe[j]);
          const fm = 0.5 * (f[b + i] - f[b + j]) - 0.5 * (fe[i] - fe[j]);
          post = f[b + i] - oP * fp - oM * fm;
        }
        let tx = x + CX[i], ty = y + CY[i];
        if (periodic) { tx = (tx + nx) % nx; ty = (ty + ny) % ny; }
        if (tx < 0 || tx >= nx || ty < 0 || ty >= ny || mask[ty * nx + tx] === SOLID)
          g[b + j] = post;                       // half-way bounce-back
        else
          g[(ty * nx + tx) * 9 + i] = post;      // stream
      }
    }
    this._applyInlet(g);
    this._applyOutlet(g);
    this.f = g; this.g = f;                      // ping-pong (old f becomes scratch)
    this.steps++;
    this._accumulate();
  }

  _accumulate() {
    const { nx, ny, mask, f, probeCol, avgU } = this;
    let finV = 0, finM = 0, foutM = 0;
    for (let x = 0; x < nx; x++) {
      if (mask[x] !== INLET || mask[nx + x] === SOLID) continue;
      const b = (nx + x) * 9;
      let r = 0, my = 0;
      for (let i = 0; i < 9; i++) { r += f[b + i]; my += f[b + i] * CY[i]; }
      finV += my / r; finM += my;
    }
    for (let y = 0; y < ny; y++) {
      const c = y * nx + probeCol;
      if (mask[c] === SOLID) continue;
      const b = c * 9;
      let r = 0, mx = 0;
      for (let i = 0; i < 9; i++) { r += f[b + i]; mx += f[b + i] * CX[i]; }
      avgU[y] += mx / r; foutM += mx;
    }
    this.avgInVol += finV; this.avgInMass += finM; this.avgOutMass += foutM;
    this.avgCount++;
  }

  resetAverage() {
    this.avgU.fill(0);
    this.avgInVol = 0; this.avgInMass = 0; this.avgOutMass = 0; this.avgCount = 0;
  }

  // time-averaged exit profile and fluxes since the last resetAverage()
  timeAveraged() {
    const { nx, ny, mask, probeCol, avgU, avgCount } = this;
    const n = Math.max(1, avgCount);
    const ys = [], us = [];
    for (let y = 0; y < ny; y++) {
      if (mask[y * nx + probeCol] === SOLID) continue;
      ys.push(y); us.push(avgU[y] / n);
    }
    return { y: Int32Array.from(ys), u: Float32Array.from(us),
             inVol: this.avgInVol / n, inMass: this.avgInMass / n,
             outMass: this.avgOutMass / n, samples: avgCount };
  }

  _applyInlet(g) {
    const v = this.uIn * (this.ramp > 0 ? Math.min(1, this.steps / this.ramp) : 1);
    for (const c of this.inletCells) {
      const b = c * 9;
      const S = g[b] + g[b + 1] + g[b + 3];
      const K = g[b + 4] + g[b + 7] + g[b + 8];
      const rho = (S + 2 * K) / (1 - v);
      const t = 0.5 * (g[b + 1] - g[b + 3]);
      g[b + 2] = g[b + 4] + (2 / 3) * rho * v;   // Zou-He, flow +y (down)
      g[b + 5] = g[b + 7] + rho * v / 6 - t;
      g[b + 6] = g[b + 8] + rho * v / 6 + t;
    }
  }

  _applyOutlet(g) {
    for (const c of this.outletCells) {
      const b = c * 9, bn = (c - 1) * 9;         // neighbor one column left
      g[b + 3] = g[bn + 3]; g[b + 6] = g[bn + 6]; g[b + 7] = g[bn + 7];
      let rho = 0;
      for (let i = 0; i < 9; i++) rho += g[b + i];
      const s = 1 / rho;                          // renormalize: anchors pressure
      for (let i = 0; i < 9; i++) g[b + i] *= s;
    }
  }

  isStable() {
    const { nx, ny, mask, f } = this;
    for (let c = 0; c < nx * ny; c += 17) {          // sampled scan
      if (mask[c] === SOLID) continue;
      const b = c * 9;
      let r = 0, mx = 0, my = 0;
      for (let i = 0; i < 9; i++) { const fi = f[b + i]; r += fi; mx += fi * CX[i]; my += fi * CY[i]; }
      if (!Number.isFinite(r) || r <= 0) return false;
      if ((mx * mx + my * my) / (r * r) > 0.4 * 0.4) return false;
    }
    return true;
  }

  // inlet flux (sum uy over duct row 1) and outlet flux (sum ux at probeCol)
  fluxes() {
    const { nx, ny, mask, f, probeCol } = this;
    let fin = 0, fout = 0;
    for (let x = 0; x < nx; x++) {
      const c = nx + x;                               // row y=1
      if (mask[c] === SOLID || mask[x] !== INLET) continue;
      const b = c * 9;
      let r = 0, my = 0;
      for (let i = 0; i < 9; i++) { r += f[b + i]; my += f[b + i] * CY[i]; }
      fin += my / r;
    }
    for (let y = 0; y < ny; y++) {
      const c = y * nx + probeCol;
      if (mask[c] === SOLID) continue;
      const b = c * 9;
      let r = 0, mx = 0;
      for (let i = 0; i < 9; i++) { r += f[b + i]; mx += f[b + i] * CX[i]; }
      fout += mx / r;
    }
    return { in: fin, out: fout };
  }

  // streamwise velocity sampled at probeCol (the physical exit plane), fluid cells only
  exitProfile() {
    const { nx, ny, mask, f, probeCol } = this;
    const ys = [], us = [];
    for (let y = 0; y < ny; y++) {
      const c = y * nx + probeCol;
      if (mask[c] === SOLID) continue;
      const b = c * 9;
      let r = 0, mx = 0;
      for (let i = 0; i < 9; i++) { r += f[b + i]; mx += f[b + i] * CX[i]; }
      ys.push(y); us.push(mx / r);
    }
    return { y: Int32Array.from(ys), u: Float32Array.from(us) };
  }

  macros() {
    const { nx, ny, mask, f } = this;
    const rho = new Float32Array(nx * ny), ux = new Float32Array(nx * ny), uy = new Float32Array(nx * ny);
    for (let c = 0; c < nx * ny; c++) {
      if (mask[c] === SOLID) continue;
      const b = c * 9;
      let r = 0, mx = 0, my = 0;
      for (let i = 0; i < 9; i++) { const fi = f[b + i]; r += fi; mx += fi * CX[i]; my += fi * CY[i]; }
      rho[c] = r; ux[c] = mx / r; uy[c] = my / r;
    }
    return { rho, ux, uy };
  }
}

// std/mean of the exit profile: 0 = perfect plug flow, grows unbounded.
// Used as the optimizer cost (stays informative where the clamped score saturates).
export function nonUniformity(profile) {
  const n = profile.length;
  if (!n) return Infinity;
  let mean = 0;
  for (const v of profile) mean += v;
  mean /= n;
  if (mean <= 1e-12) return Infinity;
  let varSum = 0;
  for (const v of profile) varSum += (v - mean) * (v - mean);
  return Math.sqrt(varSum / n) / mean;
}

// display score: 1 - std/mean, clamped to [0, 1]
export function uniformity(profile) {
  const nu = nonUniformity(profile);
  return Number.isFinite(nu) ? Math.max(0, Math.min(1, 1 - nu)) : 0;
}
