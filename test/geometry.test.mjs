import { test, ok, approx } from './harness.mjs';
import { DEFAULT_PARAMS, CAPS, derived, violations, maxTheta1, maxD5, clampParams }
  from '../js/geometry.js';

test('baseline parameters satisfy both caps', () => {
  const d = derived(DEFAULT_PARAMS);
  ok(d.totalLen <= CAPS.totalLenMM, `len ${d.totalLen}`);
  ok(d.exitHeight <= CAPS.exitHeightMM, `height ${d.exitHeight}`);
  ok(violations(DEFAULT_PARAMS).length === 0);
});

test('derived values are correct', () => {
  const p = { ...DEFAULT_PARAMS, d4: 20, d5: 100, theta1: 30 };
  const d = derived(p);
  approx(d.exitHeight, 20 + 2 * 100 * Math.tan(Math.PI / 6), 1e-9);
  approx(d.totalLen, p.d1 + p.d2 + p.d3 + p.d5 + p.d6, 1e-9);
});

test('violations flags each cap', () => {
  ok(violations({ ...DEFAULT_PARAMS, d5: 300 }).includes('length'));
  ok(violations({ ...DEFAULT_PARAMS, theta1: 40 }).includes('height'));
});

test('maxTheta1/maxD5 sit exactly on the caps', () => {
  const p = { ...DEFAULT_PARAMS };
  const t1 = maxTheta1(p);
  ok(violations({ ...p, theta1: t1 - 0.01 }).length === 0);
  ok(violations({ ...p, theta1: t1 + 0.1 }).includes('height'));
  const d5 = maxD5(p);
  ok(violations({ ...p, d5: d5 - 0.01 }).length === 0);
  ok(violations({ ...p, d5: d5 + 1 }).length > 0);
});

test('clampParams repairs random violating draws', () => {
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let k = 0; k < 200; k++) {
    const p = {
      d1: 12.7, d2: 8 + rnd() * 30, d3: 8 + rnd() * 40, d4: 10 + rnd() * 30,
      d5: 60 + rnd() * 200, d6: 10 + rnd() * 50,
      theta1: 5 + rnd() * 35, theta2: rnd() * 40, nVanes: Math.floor(rnd() * 11),
    };
    const q = clampParams(p);
    ok(violations(q).length === 0, `draw ${k} still violates: ${JSON.stringify(q)}`);
    ok(q.d4 === p.d4 && q.d1 === p.d1, 'clamp only touches theta1/d5/d6');
  }
});
