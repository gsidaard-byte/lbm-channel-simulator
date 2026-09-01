import { test, ok, approx } from './harness.mjs';
import { LBM, feq, W, CX, CY, OPP } from '../js/lbm.js';
import { FLUID, SOLID } from '../js/geometry.js';

test('feq sums to rho and momentum', () => {
  let r = 0, mx = 0, my = 0;
  for (let i = 0; i < 9; i++) {
    const f = feq(i, 1.2, 0.05, -0.03);
    r += f; mx += f * CX[i]; my += f * CY[i];
  }
  approx(r, 1.2, 1e-12); approx(mx, 1.2 * 0.05, 1e-12); approx(my, 1.2 * -0.03, 1e-12);
});

test('Taylor-Green vortex decays at the analytic viscous rate', () => {
  const n = 64, tau = 0.8, nu = (tau - 0.5) / 3, u0 = 0.04, k = 2 * Math.PI / n;
  const mask = new Uint8Array(n * n).fill(FLUID);
  const sim = new LBM({ nx: n, ny: n, mask, tau, uIn: 0, periodic: true });
  sim.initEquilibrium(() => 1, (x, y) => [-u0 * Math.cos(k * x) * Math.sin(k * y),
                                           u0 * Math.sin(k * x) * Math.cos(k * y)]);
  const steps = 400;
  sim.step(steps);
  const { ux } = sim.macros();
  let amp = 0;
  for (const v of ux) amp = Math.max(amp, Math.abs(v));
  const expected = u0 * Math.exp(-nu * 2 * k * k * steps);
  approx(amp, expected, 0.02 * expected, 'TG decay amplitude');
});

test('wall-bounded shear mode decays at the analytic rate (bounce-back)', () => {
  const nx = 8, ny = 34, H = ny - 2, tau = 0.9, nu = (tau - 0.5) / 3, u0 = 0.03;
  const mask = new Uint8Array(nx * ny).fill(FLUID);
  for (let x = 0; x < nx; x++) { mask[x] = SOLID; mask[(ny - 1) * nx + x] = SOLID; }
  const sim = new LBM({ nx, ny, mask, tau, uIn: 0, periodic: true });
  // ux = u0 sin(pi*(y-0.5)/H): zero at half-way wall planes y=0.5 and y=ny-1.5
  sim.initEquilibrium(() => 1, (x, y) => [u0 * Math.sin(Math.PI * (y - 0.5) / H), 0]);
  const steps = 600;
  sim.step(steps);
  const { ux } = sim.macros();
  let amp = 0;
  for (const v of ux) amp = Math.max(amp, Math.abs(v));
  const expected = u0 * Math.exp(-nu * (Math.PI / H) ** 2 * steps);
  approx(amp, expected, 0.03 * expected, 'channel mode decay');
});

import { uniformity } from '../js/lbm.js';
import { buildMask, DEFAULT_PARAMS } from '../js/geometry.js';
import { inletVelocity, latticeParams } from '../js/units.js';

test('uniformity: 1 for plug flow, lower for peaked flow, 0-guarded', () => {
  approx(uniformity(new Float32Array([2, 2, 2, 2])), 1, 1e-9);
  const peaked = uniformity(new Float32Array([0.5, 2, 4, 2, 0.5]));
  ok(peaked > 0 && peaked < 0.8, `peaked=${peaked}`);
  approx(uniformity(new Float32Array([0, 0])), 0, 1e-9);
});

test('integration: baseline geometry runs stable and conserves mass', async () => {
  const dxMM = 1.5, depthM = 0.0127, mdot = 6e-3;
  const geo = buildMask(DEFAULT_PARAMS, dxMM);
  ok(geo.ok && geo.meta.connected);
  const uPhys = inletVelocity(mdot, DEFAULT_PARAMS.d1 / 1000, depthM);
  const uMax = uPhys * Math.max(1, DEFAULT_PARAMS.d1 / DEFAULT_PARAMS.d4);
  const lp = latticeParams({ dxM: dxMM / 1000, uMaxPhys: uMax });
  const sim = new LBM({ nx: geo.nx, ny: geo.ny, mask: geo.mask,
                        tau: lp.tau, uIn: uPhys * lp.dt / (dxMM / 1000), ramp: 800,
                        probeCol: geo.meta.probeCol, spongeW: geo.meta.bufferW });
  sim.step(6000);                 // develop past the transient
  ok(sim.isStable(), 'no NaN / runaway velocity');
  sim.resetAverage();
  sim.step(10000);                // average over several flapping periods
  ok(sim.isStable(), 'stable during averaging');
  const avg = sim.timeAveraged();
  ok(Math.abs(avg.out - avg.in) / avg.in < 0.05,
     `mass imbalance in=${avg.in} out=${avg.out}`);
  const u = uniformity(avg.u);
  ok(u > 0.1 && u <= 1, `uniformity ${u}`);
});
