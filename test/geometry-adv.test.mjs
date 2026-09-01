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

test('advanced: printable plates are solid rib arrays with correct open area', () => {
  const p = { ...ADV_DEFAULTS, scrMode: 'plate', sc1s: 0.5, sc1g: 4, sc2s: 0 };
  const g = buildMaskAdvanced(p, 0.5);
  ok(g.ok && g.meta.connected, 'connected through plate slots');
  ok(g.porous.every(v => v === 0), 'no porous cells in plate mode');
  // measure open-area fraction in the plate band vs just upstream of it
  const dx = 0.5, margin = g.margin;
  const xPlate = 12.7 + 15 + ADV_DEFAULTS.tl + ADV_DEFAULTS.sc1x + 1;   // inside plate
  const col = (xmm) => Math.round((xmm + margin * dx) / dx - 0.5);
  const fluidCount = (gx) => {
    let n = 0;
    for (let gy = 0; gy < g.ny; gy++) if (g.mask[gy * g.nx + gx] !== 0) n++;
    return n;
  };
  const open = fluidCount(col(xPlate)) / fluidCount(col(xPlate - 6));
  ok(Math.abs(open - 0.5) < 0.12, `open area ~50% (got ${(open * 100).toFixed(0)}%)`);
});

test('advanced: two plates are staggered relative to each other', () => {
  const p = { ...ADV_DEFAULTS, scrMode: 'plate', sc1s: 0.5, sc2s: 0.5, sc1g: 4, sc2g: 4,
              sc1x: 150, sc2x: 170 };
  const g = buildMaskAdvanced(p, 0.5);
  ok(g.ok && g.meta.connected);
  const dx = 0.5, margin = g.margin;
  const col = (xmm) => Math.round((xmm + margin * dx) / dx - 0.5);
  const pat = (gx) => {
    let s = '';
    for (let gy = 0; gy < g.ny; gy++) s += g.mask[gy * g.nx + gx] === 0 ? '#' : '.';
    return s;
  };
  const base = 12.7 + 15 + ADV_DEFAULTS.tl;
  const p1 = pat(col(base + 150 + 1)), p2 = pat(col(base + 170 + 1));
  ok(p1 !== p2, 'staggered rib patterns differ');
});

test('advanced: coarse-grid fallback to porous when slots are unresolvable', () => {
  const g = buildMaskAdvanced({ ...ADV_DEFAULTS, scrMode: 'plate', sc1g: 2, sc2g: 2 }, 1.5);
  ok(g.ok && g.meta.connected);
  let nPorous = 0;
  for (const v of g.porous) if (v > 0) nPorous++;
  ok(nPorous > 100, 'fell back to porous cells at coarse grid');
});

test('advanced: screens appear in the porous array with the set solidity', () => {
  const g = buildMaskAdvanced({ ...ADV_DEFAULTS, scrMode: 'porous', sc1s: 0.7, sc2s: 0 }, 1.0);
  let n7 = 0, nOther = 0;
  for (let i = 0; i < g.porous.length; i++) {
    if (Math.abs(g.porous[i] - 0.7) < 1e-6) n7++;
    else if (g.porous[i] > 0) nOther++;
  }
  ok(n7 > 100, `screen 1 cells present (${n7})`);
  ok(nOther === 0, 'disabled screen absent');
  const g0 = buildMaskAdvanced({ ...ADV_DEFAULTS, scrMode: 'porous', sc1s: 0, sc2s: 0 }, 1.0);
  ok(g0.porous.every(v => v === 0), 'no screens when solidity 0');
});

test('advanced integration: printable plates achieve good uniformity', async () => {
  const plate = await runAdvanced({ scrMode: 'plate', sc1g: 4, sc2g: 4 }, 18000, 1.0);
  ok(plate, 'plate config ran stably');
  ok(plate.massErr < 0.06, `mass err ${plate.massErr}`);
  ok(plate.score > 0.5, `plate uniformity ${plate.score.toFixed(3)}`);
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

async function runAdvanced(over, steps = 18000, dxMM = 1.5) {
  const p = advClamp({ ...ADV_DEFAULTS, ...over });
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

test('advanced: screen-2 uniform fit gives equal slots wall to wall', () => {
  const dx = 0.5;
  const slotRuns = (fit) => {
    const p = { ...ADV_DEFAULTS, scrMode: 'plate', sc1s: 0, sc2s: 0.4, sc2g: 5, sc2fit: fit };
    const g = buildMaskAdvanced(p, dx);
    ok(g.ok && g.meta.connected);
    const col = Math.round((12.7 + 15 + ADV_DEFAULTS.tl + ADV_DEFAULTS.sc2x + 1 + g.margin * dx) / dx - 0.5);
    const runs = [];
    let run = 0;
    for (let gy = 0; gy < g.ny; gy++) {
      const fluid = g.mask[gy * g.nx + col] !== 0;
      if (fluid) run++;
      else if (run > 0) { runs.push(run); run = 0; }
    }
    if (run > 0) runs.push(run);
    return runs;
  };
  const fitted = slotRuns(true);
  ok(fitted.length >= 5, `several slots (${fitted.length})`);
  ok(Math.max(...fitted) - Math.min(...fitted) <= 1,
     `fitted slots uniform within one cell (${Math.min(...fitted)}..${Math.max(...fitted)})`);
  const unfitted = slotRuns(false);
  ok(Math.max(...unfitted) - Math.min(...unfitted) > 1,
     `unfitted pattern has unequal edge slots (${Math.min(...unfitted)}..${Math.max(...unfitted)})`);
});

test('advanced: four-screen ladder builds and stays connected', () => {
  const p = { ...ADV_DEFAULTS, scrMode: 'plate',
              sc3s: 0.4, sc3x: 8, sc3g: 3, sc4s: 0.4, sc4x: 55, sc4g: 4 };
  const g = buildMaskAdvanced(p, 0.5);
  ok(g.ok && g.meta.connected, 'connected through 4 plates');
  // solid ribs must now exist near the throat (expansion entrance)
  const dx = 0.5, base = 12.7 + 15 + ADV_DEFAULTS.tl;
  const col = Math.round((base + 8 + 1 + g.margin * dx) / dx - 0.5);
  let ribs = 0, fluid = 0;
  for (let gy = 0; gy < g.ny; gy++) {
    const c = g.mask[gy * g.nx + col];
    if (c === 0) ribs++; else fluid++;
  }
  ok(ribs > 5 && fluid > 10, `throat plate present (ribs ${ribs}, slots ${fluid})`);
  const off = buildMaskAdvanced({ ...ADV_DEFAULTS, scrMode: 'plate' }, 0.5);
  let ribsOff = 0;
  for (let gy = 0; gy < off.ny; gy++) if (off.mask[gy * off.nx + col] === 0) ribsOff++;
  ok(ribsOff === 0 || ribsOff < ribs, 'sc3 off by default');
});
