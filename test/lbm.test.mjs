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
