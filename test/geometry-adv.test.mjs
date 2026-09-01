import { test, ok, approx } from './harness.mjs';
import { ADV_DEFAULTS, advClamp, buildMaskAdvanced } from '../js/geometry-adv.js';
import { CAPS } from '../js/geometry.js';

test('advanced: default build is connected with fixed exit and length', () => {
  const g = buildMaskAdvanced(ADV_DEFAULTS, 1.0);
  ok(g.ok, g.error);
  ok(g.meta.connected, 'connected');
  approx(g.meta.exitHeight, CAPS.exitHeightMM, 1e-9, 'exit fixed at 8in');
  approx(g.meta.totalLen, CAPS.totalLenMM, 1e-9, 'length fixed at 9in');
  ok(g.porous instanceof Float32Array && g.porous.length === g.mask.length);
});

test('advanced: screens appear in the porous array with the set solidity', () => {
  const g = buildMaskAdvanced({ ...ADV_DEFAULTS, sc1s: 0.7, sc2s: 0 }, 1.0);
  let n7 = 0, nOther = 0;
  for (let i = 0; i < g.porous.length; i++) {
    if (Math.abs(g.porous[i] - 0.7) < 1e-6) n7++;
    else if (g.porous[i] > 0) nOther++;
  }
  ok(n7 > 100, `screen 1 cells present (${n7})`);
  ok(nOther === 0, 'disabled screen absent');
  const g0 = buildMaskAdvanced({ ...ADV_DEFAULTS, sc1s: 0, sc2s: 0 }, 1.0);
  ok(g0.porous.every(v => v === 0), 'no screens when solidity 0');
});

test('advanced: bend vanes and vane rows add solid cells', () => {
  const bare = buildMaskAdvanced({ ...ADV_DEFAULTS, bendVanes: 0, r1n: 0, r2n: 0 }, 1.0);
  const full = buildMaskAdvanced(ADV_DEFAULTS, 1.0);
  let fBare = 0, fFull = 0;
  for (let i = 0; i < bare.mask.length; i++) { if (bare.mask[i] !== 0) fBare++; if (full.mask[i] !== 0) fFull++; }
  ok(fFull < fBare, 'vanes removed fluid cells');
  ok(full.meta.connected && bare.meta.connected);
});

test('advanced: clamp keeps everything inside the budget', () => {
  const q = advClamp({ ...ADV_DEFAULTS, Lexp: 500, r1x: 400, sc1x: 999, r1c: 200 });
  const g = buildMaskAdvanced(q, 1.0);
  ok(g.ok && g.meta.connected, JSON.stringify(q));
});

test('advanced: edge configs stay connected', () => {
  for (const over of [
    { th: 8, bendVanes: 4, r1n: 12, r2n: 16 },
    { th: 40, s0: 0, s1: 0, sc1s: 0.9, sc2s: 0.9 },
    { Lexp: 60, r1x: 5, r2x: 50, r1c: 50, r2c: 50 },
  ]) {
    const g = buildMaskAdvanced(advClamp({ ...ADV_DEFAULTS, ...over }), 1.0);
    ok(g.ok && g.meta.connected, JSON.stringify(over));
  }
});

import { LBM, uniformity } from '../js/lbm.js';
import { inletVelocity, latticeParams } from '../js/units.js';

async function runAdvanced(over, steps = 18000) {
  const p = advClamp({ ...ADV_DEFAULTS, ...over });
  const dxMM = 1.5;
  const g = buildMaskAdvanced(p, dxMM);
  if (!g.ok || !g.meta.connected) return null;
  const uPhys = inletVelocity(6e-3, 12.7 / 1000, 0.0127);
  const lp = latticeParams({ dxM: dxMM / 1000, uMaxPhys: uPhys });
  const sim = new LBM({ nx: g.nx, ny: g.ny, mask: g.mask, tau: lp.tau,
                        uIn: uPhys * lp.dt / (dxMM / 1000), ramp: 800,
                        probeCol: g.meta.probeCol, spongeW: g.meta.bufferW,
                        porous: g.porous });
  sim.step(7000);
  if (!sim.isStable()) return null;
  sim.resetAverage();
  sim.step(steps - 7000);
  if (!sim.isStable()) return null;
  const avg = sim.timeAveraged();
  return { score: uniformity(avg.u),
           massErr: Math.abs(avg.outMass - avg.inMass) / avg.inMass };
}

test('advanced integration: screens + vanes beat the bare expansion', async () => {
  const bare = await runAdvanced({ bendVanes: 0, r1n: 0, r2n: 0, sc1s: 0, sc2s: 0 });
  const full = await runAdvanced({});
  ok(bare && full, 'both configs ran stably');
  ok(full.massErr < 0.06, `mass err ${full.massErr}`);
  ok(full.score > bare.score,
     `conditioning helps: full=${full.score.toFixed(3)} vs bare=${bare.score.toFixed(3)}`);
  ok(full.score > 0.5, `full config decently uniform (${full.score.toFixed(3)})`);
});
