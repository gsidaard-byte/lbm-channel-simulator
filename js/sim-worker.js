// Interactive simulation worker. Runs the LBM continuously and posts frames.
import { buildMask } from './geometry.js';
import { LBM, uniformity } from './lbm.js';
import { inletVelocity, throatReynolds, latticeParams } from './units.js';

const TRANSIENT_STEPS = 4000;   // first averaging start (early feedback)
const REBASE_STEPS = 12000;     // re-base once the flow is fully developed

let sim = null, running = false, cfg = null, lp = null, uPhysIn = 0;
let lastPost = 0, stepCount0 = 0, t0 = 0, averaging = false, rebased = false;
let inletCount = 0, fieldMode = 'speed', u2phys = 1;

// setTimeout is throttled to 1Hz in hidden tabs; MessageChannel isn't.
const loopChan = new MessageChannel();
loopChan.port1.onmessage = () => loop();
const scheduleLoop = () => loopChan.port2.postMessage(0);

onmessage = (e) => {
  const m = e.data;
  if (m.type === 'configure') configure(m);
  else if (m.type === 'pause') running = false;
  else if (m.type === 'resume' && sim) { running = true; t0 = 0; loop(); }
  else if (m.type === 'setField') fieldMode = m.field;
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
  u2phys = dxM / lp.dt;           // lattice velocity -> m/s
  inletCount = 0;                 // inlet cells counted the same way fluxes() does
  for (let x = 0; x < geo.nx; x++)
    if (geo.mask[x] === 2 && geo.mask[geo.nx + x] !== 0) inletCount++;
  postMessage({ type: 'geometry', nx: geo.nx, ny: geo.ny, dx: geo.dx, yc: geo.yc,
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
  const { nx, ny, mask } = sim;
  const { ux, uy } = sim.macros();
  // FIXED color scale per configuration (never changes over time):
  // velocities span [0, 2*uLat] (seq) or [-2*uLat, 2*uLat] (div);
  // vorticity spans +/- uLat/3 per cell. Values beyond the range saturate.
  const vmaxLat = 2.0 * lp.uLat;
  const wmaxLat = lp.uLat / 3;
  const speed = new Uint8Array(nx * ny);
  let kind = 'seq', vmaxDisp = vmaxLat * u2phys * 1000, unit = 'mm/s';
  if (fieldMode === 'speed') {
    for (let c = 0; c < nx * ny; c++)
      speed[c] = Math.min(255, (Math.hypot(ux[c], uy[c]) / vmaxLat) * 255);
  } else if (fieldMode === 'ux' || fieldMode === 'uy') {
    kind = 'div';
    // display convention: v positive upward (grid y points down)
    const sgn = fieldMode === 'uy' ? -1 : 1;
    const a = fieldMode === 'ux' ? ux : uy;
    for (let c = 0; c < nx * ny; c++)
      speed[c] = Math.max(0, Math.min(255, 128 + (sgn * a[c] / vmaxLat) * 127));
  } else { // vorticity (z, y-up convention), central differences
    kind = 'div'; vmaxDisp = wmaxLat / lp.dt; unit = '1/s';
    speed.fill(128);
    for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
      const c = y * nx + x;
      if (mask[c] === 0) continue;
      const w = -((uy[c + 1] - uy[c - 1]) / 2 - (ux[c + nx] - ux[c - nx]) / 2);
      speed[c] = Math.max(0, Math.min(255, 128 + (w / wmaxLat) * 127));
    }
  }
  const stride = 6, vnx = Math.floor(nx / stride), vny = Math.floor(ny / stride);
  const vux = new Float32Array(vnx * vny), vuy = new Float32Array(vnx * vny);
  for (let j = 0; j < vny; j++) for (let i = 0; i < vnx; i++) {
    const c = (j * stride) * nx + i * stride;
    vux[j * vnx + i] = ux[c]; vuy[j * vnx + i] = uy[c];
  }
  const inst = sim.exitProfile();
  const avg = averaging ? sim.timeAveraged() : null;
  // conservation check on MASS flux (volume flux legitimately drops across screens)
  const massErr = avg && avg.inMass > 1e-9 ? Math.abs(avg.outMass - avg.inMass) / avg.inMass : 0;
  // measured inlet flow (volume-flux based: monitors the pump setting)
  const uInLat = uPhysIn * lp.dt / (cfg.dxMM / 1000);
  const mdotMeasured = avg && inletCount > 0
    ? cfg.mdot * (avg.inVol / (uInLat * inletCount)) : null;
  // pressure drop held by screens/vanes: rho_inlet - 1 in lattice units -> Pa
  const dpPa = avg && avg.inVol > 1e-9
    ? Math.max(0, (avg.inMass / avg.inVol - 1)) / 3 * 1000 * u2phys * u2phys : null;
  const dtWall = (now - t0) / 1000;
  const stepsPerSec = dtWall > 0.05 ? (sim.steps - stepCount0) / dtWall : 0;
  stepCount0 = sim.steps; t0 = now;               // per-frame rate, not cumulative
  postMessage({
    type: 'frame', speed, maxSpeed: vmaxLat, u2phys,
    fieldMeta: { kind, vmaxDisp, unit, mode: fieldMode },
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
      dpPa: dpPa == null ? null : dpPa.toFixed(0),
      averaging,
      warnings: lp.warnings,
    },
  }, [speed.buffer, vux.buffer, vuy.buffer]);
}
