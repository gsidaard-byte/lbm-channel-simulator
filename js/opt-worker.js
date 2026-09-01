// Headless optimization worker: Nelder-Mead over selected geometry parameters,
// objective = time-averaged exit non-uniformity (std/mean) at coarse resolution.
import { buildMask, clampParams } from './geometry.js';
import { LBM, uniformity, nonUniformity } from './lbm.js';
import { inletVelocity, latticeParams } from './units.js';
import { nelderMead } from './optimizer.js';

const TRANSIENT = 7000, CHUNK = 2000, MAX_CHUNKS = 14, STEADY_TOL = 0.02;

let cancelled = false;

// setTimeout is throttled to 1Hz in hidden tabs; MessageChannel isn't.
const yieldChan = new MessageChannel();
let yieldResolve = null;
yieldChan.port1.onmessage = () => { const r = yieldResolve; yieldResolve = null; if (r) r(); };
const microYield = () => new Promise(r => { yieldResolve = r; yieldChan.port2.postMessage(0); });

onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'cancel') { cancelled = true; return; }
  if (m.type !== 'start') return;
  cancelled = false;
  const { base, free, mdots, dxMM, depthMM, maxEval, starts = 1 } = m;
  let best = { score: -1, params: null };

  const objective = async (x) => {
    const p = clampParams({ ...base, ...Object.fromEntries(free.map((f, i) =>
      [f.key, f.key === 'nVanes' ? Math.round(x[i]) : x[i]])) });
    let total = 0, scoreSum = 0;
    for (const mdot of mdots) {
      const r = await evalOnce(p, mdot, dxMM, depthMM);
      if (r == null) return 10;                   // unstable/invalid: big penalty
      total += Math.min(10, r.cost);
      scoreSum += r.score;
    }
    const score = scoreSum / mdots.length;
    if (score > best.score) { best = { score, params: p }; postMessage({ type: 'best', params: p, score }); }
    return total / mdots.length;
  };

  try {
    let evalsTotal = 0;
    const perStart = Math.max(10, Math.floor(maxEval / starts));
    for (let s = 0; s < starts && !cancelled; s++) {
      const x0 = free.map(f => s === 0
        ? (f.lo + f.hi) / 2
        : f.lo + Math.random() * (f.hi - f.lo));
      const r = await nelderMead(objective, x0,
        { bounds: free.map(f => [f.lo, f.hi]), maxEval: perStart, tol: 1e-4,
          onProgress: (pr) => postMessage({ type: 'eval', evals: evalsTotal + pr.evals,
                                            x: pr.x, score: Math.max(0, 1 - pr.fx) }),
          shouldStop: () => cancelled });
      evalsTotal += r.evals;
    }
    postMessage({ type: 'done', best, evals: evalsTotal });
  } catch (err) {
    postMessage({ type: 'error', message: String(err) });
  }
};

// Run one configuration and time-average to steadiness.
// Returns {cost, score} or null on failure.
async function evalOnce(p, mdot, dxMM, depthMM) {
  const geo = buildMask(p, dxMM);
  if (!geo.ok || !geo.meta.connected) return null;
  const dxM = dxMM / 1000;
  const uPhys = inletVelocity(mdot, p.d1 / 1000, depthMM / 1000);
  const lp = latticeParams({ dxM, uMaxPhys: uPhys * Math.max(1, p.d1 / p.d4) });
  const sim = new LBM({ nx: geo.nx, ny: geo.ny, mask: geo.mask, tau: lp.tau,
                        uIn: uPhys * lp.dt / dxM, ramp: 800,
                        probeCol: geo.meta.probeCol, spongeW: geo.meta.bufferW });
  sim.step(TRANSIENT);
  if (!sim.isStable()) return null;
  sim.resetAverage();
  let prev = null, steady = 0;
  for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
    sim.step(CHUNK);
    if (!sim.isStable()) return null;
    const cost = nonUniformity(sim.timeAveraged().u);
    if (prev != null && Math.abs(cost - prev) <= STEADY_TOL * Math.max(0.1, Math.abs(prev))) {
      if (++steady >= 2) break;
    } else steady = 0;
    prev = cost;
    if (cancelled) break;
    await microYield();                            // let cancel messages arrive
  }
  const avg = sim.timeAveraged();
  return { cost: nonUniformity(avg.u), score: uniformity(avg.u) };
}
