import { test, ok, approx } from './harness.mjs';
import { DEFAULT_PARAMS, CAPS, derived, violations, maxTheta1, maxD5, clampParams, buildMask }
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

test('buildMask baseline: fluid regions, inlet, outlet all present', () => {
  const g = buildMask(DEFAULT_PARAMS, 1.0);
  ok(g.ok, g.error);
  const { mask, nx, ny } = g;
  let nInlet = 0, nOutlet = 0, nFluid = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 2) nInlet++;
    if (mask[i] === 3) nOutlet++;
    if (mask[i] !== 0) nFluid++;
  }
  approx(nInlet, Math.round(12.7 / 1.0), 2, 'inlet width in cells');
  ok(nOutlet > 100, `outlet cells ${nOutlet}`); // exit height ~160mm at 1mm/cell
  ok(nFluid > 0.2 * nx * ny, 'substantial fluid fraction');
});

test('buildMask connectivity: inlet reaches outlet', () => {
  ok(buildMask(DEFAULT_PARAMS, 1.0).meta.connected);
});

test('vanes add solid cells and never block the channel', () => {
  const g0 = buildMask({ ...DEFAULT_PARAMS, nVanes: 0 }, 1.0);
  const g6 = buildMask({ ...DEFAULT_PARAMS, nVanes: 6 }, 1.0);
  let f0 = 0, f6 = 0;
  for (let i = 0; i < g0.mask.length; i++) { if (g0.mask[i] !== 0) f0++; if (g6.mask[i] !== 0) f6++; }
  ok(f6 < f0, 'vanes removed fluid cells');
  ok(g6.meta.connected, 'still connected with vanes');
});

test('buildMask edge cases stay connected', () => {
  for (const p of [
    { ...DEFAULT_PARAMS, theta1: 5, d5: 60 },          // shallow short diffuser
    { ...DEFAULT_PARAMS, theta1: maxTheta1(DEFAULT_PARAMS) - 0.1 }, // widest
    { ...DEFAULT_PARAMS, d4: 35, nVanes: 10, theta2: 35 },
  ]) {
    const g = buildMask(clampParams(p), 1.0);
    ok(g.ok && g.meta.connected, JSON.stringify(p));
  }
});

test('buildMask rejects violating params', () => {
  ok(!buildMask({ ...DEFAULT_PARAMS, d5: 400 }, 1.0).ok);
});

import { halfHeightAt } from '../js/geometry.js';

test('quintic wall: straight recovery, S-curve, and endpoints', () => {
  const p = { ...DEFAULT_PARAMS };            // s0 = s1 = 1
  const xd = p.d1 + p.d2 + p.d3, xe = xd + p.d5;
  const h0 = p.d4 / 2, h1 = h0 + p.d5 * Math.tan(p.theta1 * Math.PI / 180);
  approx(halfHeightAt(p, xd), h0, 1e-9, 'entry');
  approx(halfHeightAt(p, xe), h1, 1e-9, 'exit');
  approx(halfHeightAt(p, xd + p.d5 / 4), h0 + 0.25 * (h1 - h0), 1e-9, 'straight is linear');
  const pS = { ...p, s0: 0, s1: 0 };          // Bell-Mehta S-curve
  approx(halfHeightAt(pS, xd), h0, 1e-9);
  approx(halfHeightAt(pS, xe), h1, 1e-9);
  const gQuarter = (halfHeightAt(pS, xd + p.d5 / 4) - h0) / (h1 - h0);
  ok(gQuarter < 0.15, `S-curve expands slowly at entry (g=${gQuarter})`);
  approx((halfHeightAt(pS, xd + p.d5 / 2) - h0) / (h1 - h0), 0.5, 1e-9, 'S-curve symmetric');
});

test('curved diffuser mask stays connected and inside caps', () => {
  for (const [s0, s1] of [[0, 0], [0, 1.5], [1.5, 0], [1.5, 1.5]]) {
    const g = buildMask({ ...DEFAULT_PARAMS, s0, s1 }, 1.0);
    ok(g.ok && g.meta.connected, `s0=${s0} s1=${s1}`);
  }
});

test('vane position and length move the vanes', () => {
  const near = buildMask({ ...DEFAULT_PARAMS, vanePos: 20 }, 1.0);
  const far = buildMask({ ...DEFAULT_PARAMS, vanePos: 150 }, 1.0);
  ok(near.ok && far.ok && near.meta.connected && far.meta.connected);
  let differ = false;
  for (let i = 0; i < near.mask.length; i++)
    if ((near.mask[i] === 0) !== (far.mask[i] === 0)) { differ = true; break; }
  ok(differ, 'masks differ when vanes move');
  const long = buildMask({ ...DEFAULT_PARAMS, vanePos: 20, vaneLen: 50 }, 1.0);
  let fLong = 0, fShort = 0;
  for (let i = 0; i < long.mask.length; i++) { if (long.mask[i] !== 0) fLong++; if (near.mask[i] !== 0) fShort++; }
  ok(fLong < fShort, 'longer vanes remove more fluid');
});

test('clampParams keeps vanes inside the channel', () => {
  const q = clampParams({ ...DEFAULT_PARAMS, vanePos: 500, vaneLen: 40 });
  ok(q.vanePos + q.vaneLen <= q.d5 + q.d6 + 1e-9, `vanePos=${q.vanePos}`);
  ok(q.vanePos >= 0);
});
