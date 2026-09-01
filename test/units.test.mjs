import { test, ok, approx } from './harness.mjs';
import { RHO, NU, inletVelocity, throatReynolds, hzFromMdot, mdotFromHz, latticeParams }
  from '../js/units.js';

test('inlet velocity from mass flow', () => {
  // 6 g/s of water through 12.7mm x 12.7mm duct
  const u = inletVelocity(6e-3, 0.0127, 0.0127);
  approx(u, 6e-3 / (1000 * 0.0127 * 0.0127), 1e-12);
});

test('throat Reynolds independent of d4 (continuity)', () => {
  approx(throatReynolds(0.05, 0.0127), 0.05 * 0.0127 / 1e-6, 1e-6);
});

test('calibration round-trip', () => {
  approx(mdotFromHz(hzFromMdot(7e-3)), 7e-3, 1e-9);
  // anchors from FlowRatevsFrequency.png: ~2.3 g/s @ 6 Hz, ~11.5 g/s @ 42 Hz
  approx(mdotFromHz(6), 2.3e-3, 1e-4);
  approx(mdotFromHz(42), 11.5e-3, 1e-4);
});

test('latticeParams honors Mach cap when viscosity allows', () => {
  const lp = latticeParams({ dxM: 5e-4, uMaxPhys: 0.02 });
  approx(lp.uLat, 0.1, 1e-9, 'uLat');
  ok(lp.tau >= 0.51, 'tau floor');
  approx(NU * lp.dt / (5e-4 * 5e-4), (lp.tau - 0.5) / 3, 1e-12, 'nu consistency');
});

test('latticeParams enforces tau floor for fast flows', () => {
  const lp = latticeParams({ dxM: 5e-4, uMaxPhys: 0.2 });
  approx(lp.tau, 0.51, 1e-9);
  ok(lp.uLat > 0.1, 'accepts higher lattice velocity');
  ok(lp.warnings.includes('smagorinsky-recommended'));
});

test('unit round-trip: physical <-> lattice velocity', () => {
  const lp = latticeParams({ dxM: 5e-4, uMaxPhys: 0.05 });
  const uPhys = 0.031;
  approx((uPhys * lp.dt / 5e-4) * (5e-4 / lp.dt), uPhys, 1e-12);
});
