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
  // {nx, ny, mask, tau, uIn (lattice, +y at inlet), magic=0.25, smagorinsky=0, periodic=false}
  constructor({ nx, ny, mask, tau, uIn, magic = 0.25, smagorinsky = 0, periodic = false }) {
    this.nx = nx; this.ny = ny; this.mask = mask;
    this.tau = tau; this.uIn = uIn; this.smag = smagorinsky; this.periodic = periodic;
    this.omP = 1 / tau;
    this.omM = 1 / (0.5 + magic / (tau - 0.5));
    this.f = new Float64Array(nx * ny * 9);
    this.g = new Float64Array(nx * ny * 9);
    this.steps = 0;
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
    const { nx, ny, mask, f, g, omP, omM, periodic, smag, tau } = this;
    const fe = new Float64Array(9);
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const c = y * nx + x;
      if (mask[c] === SOLID) continue;
      const b = c * 9;
      let rho = 0, mx = 0, my = 0;
      for (let i = 0; i < 9; i++) { const fi = f[b + i]; rho += fi; mx += fi * CX[i]; my += fi * CY[i]; }
      const ux = mx / rho, uy = my / rho;
      for (let i = 0; i < 9; i++) fe[i] = feq(i, rho, ux, uy);
      let oP = omP, oM = omM;
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
      for (let i = 0; i < 9; i++) {
        const j = OPP[i];
        const fp = 0.5 * (f[b + i] + f[b + j]) - 0.5 * (fe[i] + fe[j]);
        const fm = 0.5 * (f[b + i] - f[b + j]) - 0.5 * (fe[i] - fe[j]);
        const post = f[b + i] - oP * fp - oM * fm;
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
  }

  _applyInlet(g) {
    const v = this.uIn;
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
