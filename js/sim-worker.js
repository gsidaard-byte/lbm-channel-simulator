// Interactive simulation worker. Runs the LBM continuously and posts frames.
import { buildMask } from './geometry.js';
import { LBM, uniformity } from './lbm.js';
import { inletVelocity, throatReynolds, latticeParams } from './units.js';

const TRANSIENT_STEPS = 4000;   // first averaging start (early feedback)
const REBASE_STEPS = 12000;     // re-base once the flow is fully developed

let sim = null, running = false, cfg = null, lp = null, uPhysIn = 0;
let lastPost = 0, stepCount0 = 0, t0 = 0, averaging = false, rebased = false;
let refMax = 0, inletCount = 0;

// setTimeout is throttled to 1Hz in hidden tabs; MessageChannel isn't.
const loopChan = new MessageChannel();
loopChan.port1.onmessage = () => loop();
const scheduleLoop = () => loopChan.port2.postMessage(0);

onmessage = (e) => {
  const m = e.data;
  if (m.type === 'configure') configure(m);
  else if (m.type === 'pause') running = false;
  else if (m.type === 'resume' && sim) { running = true; t0 = 0; loop(); }
};

function configure(m) {
  running = false;
  cfg = m;
  const geo = buildMask(m.params, m.dxMM);
  if (!geo.ok) { postMessage({ type: 'error', message: geo.error }); return; }
  if (!geo.meta.connected) { postMessage({ type: 'error', message: 'geometry not connected inlet→outlet' }); return; }
  cfg.geo = geo;
  const dxM = m.dxMM / 1000;
  uPhysIn = inletVelocity(m.mdot, m.params.d1 / 1000, m.depthMM / 1000);
  const uMaxPhys = uPhysIn * Math.max(1, m.params.d1 / m.params.d4);
  lp = latticeParams({ dxM, uMaxPhys });
  sim = new LBM({ nx: geo.nx, ny: geo.ny, mask: geo.mask, tau: lp.tau,
                  uIn: uPhysIn * lp.dt / dxM, ramp: 800,
                  probeCol: geo.meta.probeCol, spongeW: geo.meta.bufferW,
                  smagorinsky: m.smag || 0 });
  averaging = false; rebased = false;
  refMax = 1.2 * lp.uLat;         // stable color-scale reference (slow-adapting)
  inletCount = 0;                 // inlet cells counted the same way fluxes() does
  for (let x = 0; x < geo.nx; x++)
    if (geo.mask[x] === 2 && geo.mask[geo.nx + x] !== 0) inletCount++;
  postMessage({ type: 'geometry', nx: geo.nx, ny: geo.ny, dx: geo.dx,
                mask: geo.mask.slice(), meta: geo.meta });
  stepCount0 = 0; t0 = 0;
  running = true;
  loop();
}

function loop() {
  if (!running || !sim) return;
  sim.step(cfg.dxMM >= 1 ? 40 : 15);
  if (!averaging && sim.steps >= TRANSIENT_STEPS) { sim.resetAverage(); averaging = true; }
  else if (averaging && !rebased && sim.steps >= REBASE_STEPS) { sim.resetAverage(); rebased = true; }
  if (sim.steps % 200 < 40 && !sim.isStable()) {
    running = false;
    postMessage({ type: 'unstable' });
    return;
  }
  const now = performance.now();
  if (t0 === 0) { t0 = now; stepCount0 = sim.steps; }
  if (now - lastPost > 66) { lastPost = now; postFrame(now); }
  scheduleLoop();
}

function postFrame(now) {
  const { nx, ny } = sim;
  const { ux, uy } = sim.macros();
  const speed = new Uint8Array(nx * ny);
  let maxS = 1e-9;
  const sMag = new Float32Array(nx * ny);
  for (let c = 0; c < nx * ny; c++) {
    const s = Math.hypot(ux[c], uy[c]);
    sMag[c] = s;
    if (s > maxS) maxS = s;
  }
  // Stable color scale: adapt the reference upward instantly but decay it very
  // slowly, so colors don't pulse with the flapping jet's instantaneous max.
  refMax = Math.max(maxS, refMax * 0.999, 1.2 * lp.uLat);
  for (let c = 0; c < nx * ny; c++) speed[c] = Math.min(255, (sMag[c] / refMax) * 255);
  const stride = 6, vnx = Math.floor(nx / stride), vny = Math.floor(ny / stride);
  const vux = new Float32Array(vnx * vny), vuy = new Float32Array(vnx * vny);
  for (let j = 0; j < vny; j++) for (let i = 0; i < vnx; i++) {
    const c = (j * stride) * nx + i * stride;
    vux[j * vnx + i] = ux[c]; vuy[j * vnx + i] = uy[c];
  }
  const inst = sim.exitProfile();
  const avg = averaging ? sim.timeAveraged() : null;
  const massErr = avg && avg.in > 1e-9 ? Math.abs(avg.out - avg.in) / avg.in : 0;
  // measured inlet mass flow (time-averaged lattice flux vs the imposed target)
  const uInLat = uPhysIn * lp.dt / (cfg.dxMM / 1000);
  const mdotMeasured = avg && inletCount > 0
    ? cfg.mdot * (avg.in / (uInLat * inletCount)) : null;
  const dtWall = (now - t0) / 1000;
  const stepsPerSec = dtWall > 0.05 ? (sim.steps - stepCount0) / dtWall : 0;
  stepCount0 = sim.steps; t0 = now;               // per-frame rate, not cumulative
  postMessage({
    type: 'frame', speed, maxSpeed: refMax,
    vec: { stride, nx: vnx, ny: vny, ux: vux, uy: vuy },
    profile: { y: inst.y, u: inst.u },
    avgProfile: avg ? { y: avg.y, u: avg.u } : null,
    score: avg ? uniformity(avg.u) : null,
    stats: {
      re: Math.round(throatReynolds(uPhysIn, cfg.params.d1 / 1000)),
      reEff: Math.round(throatReynolds(uPhysIn, cfg.params.d1 / 1000) * lp.reScale),
      mach: lp.uLat.toFixed(3), tau: lp.tau.toFixed(4),
      stepsPerSec: Math.round(stepsPerSec),
      tPhys: (sim.steps * lp.dt).toFixed(2),
      massErrPct: (massErr * 100).toFixed(1),
      mdotSet: cfg.mdot * 1000,
      mdotMeasured: mdotMeasured == null ? null : mdotMeasured * 1000,
      averaging,
      warnings: lp.warnings,
    },
  }, [speed.buffer, vux.buffer, vuy.buffer]);
}
