import { test, ok, approx } from './harness.mjs';
import { CH_DEFAULTS, chClamp, buildMaskCoathanger } from '../js/geometry-ch.js';
import { CAPS } from '../js/geometry.js';

test('coathanger: default build connected, fixed exit and length', () => {
  const g = buildMaskCoathanger(CH_DEFAULTS, 0.5);
  ok(g.ok, g.error);
  ok(g.meta.connected, 'connected');
  approx(g.meta.exitHeight, CAPS.exitHeightMM, 1e-9);
  approx(g.meta.totalLen, CAPS.totalLenMM, 1e-9);
});

test('coathanger: header tapers from center to both tips', () => {
  const g = buildMaskCoathanger(CH_DEFAULTS, 0.5);
  const dx = 0.5, { nx, ny, mask, margin, yc } = g;
  // header fluid width (columns) measured at center vs near a tip
  const widthAt = (ymm) => {
    const gy = Math.round(ymm / dx - 0.5);
    let w = 0;
    const xh = CH_DEFAULTS.xh;
    for (let gx = 0; gx < nx; gx++) {
      const xmm = (gx + 0.5) * dx - margin * dx;
      if (xmm > xh - 40 && xmm < xh && mask[gy * nx + gx] !== 0) w++;
    }
    return w;
  };
  const wc = widthAt(yc), wt = widthAt(yc + 0.85 * CAPS.exitHeightMM / 2);
  ok(wc > 2 * wt, `taper: center ${wc} cols vs tip ${wt} cols`);
});

test('coathanger: land plate is a fitted rib array across the exit span', () => {
  const g = buildMaskCoathanger(CH_DEFAULTS, 0.5);
  const dx = 0.5;
  const col = Math.round((CH_DEFAULTS.xh + 1 + g.margin * dx) / dx - 0.5);
  const runs = [];
  let run = 0;
  for (let gy = 0; gy < g.ny; gy++) {
    if (g.mask[gy * g.nx + col] !== 0) run++;
    else if (run > 0) { runs.push(run); run = 0; }
  }
  if (run > 0) runs.push(run);
  ok(runs.length >= 10, `many slots (${runs.length})`);
  ok(Math.max(...runs) - Math.min(...runs) <= 1, 'uniform slots');
});

test('coathanger: optional settling plate adds solid cells downstream of land', () => {
  const bare = buildMaskCoathanger({ ...CH_DEFAULTS, sp_s: 0 }, 0.5);
  const withP = buildMaskCoathanger({ ...CH_DEFAULTS, sp_s: 0.3 }, 0.5);
  let fB = 0, fW = 0;
  for (let i = 0; i < bare.mask.length; i++) { if (bare.mask[i] !== 0) fB++; if (withP.mask[i] !== 0) fW++; }
  ok(fW < fB, 'settling plate removed fluid cells');
  ok(withP.meta.connected);
});

test('coathanger: clamp keeps geometry buildable at extremes', () => {
  for (const over of [
    { w0: 30, w1: 2, landS: 0.92 },
    { wt: 10, xh: 205, landG: 2 },
    { w0: 8, wt: 24, xh: 150 },
  ]) {
    const g = buildMaskCoathanger(chClamp({ ...CH_DEFAULTS, ...over }), 0.5);
    ok(g.ok && g.meta.connected, JSON.stringify(over));
  }
});
