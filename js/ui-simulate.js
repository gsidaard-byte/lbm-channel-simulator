// Simulate tab: sliders, live field rendering, exit profile, uniformity score.
import { DEFAULT_PARAMS, CAPS, derived, violations, clampParams, SOLID } from './geometry.js';
import { MDOT_MIN, MDOT_MAX, hzFromMdot } from './units.js';

const SLIDERS = [
  { key: 'd1', label: 'd₁ mm', min: 12.7, max: 12.7, step: 0.1 },   // fixed by hardware
  { key: 'd2', label: 'd₂ mm', min: 6, max: 40, step: 0.5 },
  { key: 'd3', label: 'd₃ mm', min: 5, max: 60, step: 0.5 },
  { key: 'd4', label: 'd₄ mm', min: 8, max: 40, step: 0.5 },
  { key: 'd5', label: 'd₅ mm', min: 40, max: 200, step: 1 },
  { key: 'd6', label: 'd₆ mm', min: 8, max: 60, step: 0.5 },
  { key: 'theta1', label: 'θ₁ °', min: 3, max: 40, step: 0.25 },
  { key: 'theta2', label: 'θ₂ °', min: 0, max: 45, step: 0.25 },
  { key: 'nVanes', label: 'vanes', min: 0, max: 10, step: 1 },
];
const RES = { coarse: 1.0, medium: 0.5, fine: 0.35 };

let worker = null, params = { ...DEFAULT_PARAMS }, mdot = 6e-3, dxMM = RES.coarse;
let geo = null, debounceT = 0, sparkHist = [], els = {};

export function init() {
  buildControls();
  worker = new Worker('./js/sim-worker.js', { type: 'module' });
  worker.onmessage = onWorkerMessage;
  reconfigure();
}

export function setParams(p) {
  params = clampParams({ ...params, ...p });
  for (const s of SLIDERS) {
    els[s.key].range.value = params[s.key];
    els[s.key].num.value = params[s.key];
  }
  updateReadouts();
  reconfigure();
  document.getElementById('tab-simulate').click();
}

export function getParams() { return { ...params }; }

function buildControls() {
  const root = document.getElementById('sim-controls');
  for (const s of SLIDERS) {
    const row = document.createElement('div');
    row.className = 'ctl';
    row.innerHTML = `<label>${s.label}</label>
      <input type="range" min="${s.min}" max="${s.max}" step="${s.step}" value="${params[s.key]}">
      <input type="number" min="${s.min}" max="${s.max}" step="${s.step}" value="${params[s.key]}">`;
    const [range, num] = row.querySelectorAll('input');
    const onChange = (v) => {
      params[s.key] = s.key === 'nVanes' ? Math.round(+v) : +v;
      params = clampParams(params);
      range.value = num.value = params[s.key];
      updateReadouts();
      clearTimeout(debounceT);
      debounceT = setTimeout(reconfigure, 150);
    };
    range.addEventListener('input', () => onChange(range.value));
    num.addEventListener('change', () => onChange(num.value));
    els[s.key] = { range, num };
    root.appendChild(row);
  }
  const flowRow = document.createElement('div');
  flowRow.className = 'ctl';
  flowRow.innerHTML = `<label>flow g/s</label>
    <input type="range" min="${MDOT_MIN * 1000}" max="${MDOT_MAX * 1000}" step="0.1" value="${mdot * 1000}">
    <input type="number" step="0.1" value="${mdot * 1000}">`;
  const [fr, fn] = flowRow.querySelectorAll('input');
  const onFlow = (v) => {
    mdot = +v / 1000; fr.value = fn.value = +v;
    updateReadouts();
    clearTimeout(debounceT); debounceT = setTimeout(reconfigure, 150);
  };
  fr.addEventListener('input', () => onFlow(fr.value));
  fn.addEventListener('change', () => onFlow(fn.value));
  root.appendChild(flowRow);

  const resRow = document.createElement('div');
  resRow.className = 'ctl';
  resRow.innerHTML = `<label>grid</label><select>
      <option value="coarse" selected>coarse (1.0 mm)</option>
      <option value="medium">medium (0.5 mm)</option>
      <option value="fine">fine (0.35 mm)</option></select>
    <button class="action" id="btn-pause">Pause</button>`;
  resRow.querySelector('select').addEventListener('change', (e) => {
    dxMM = RES[e.target.value]; reconfigure();
  });
  root.appendChild(resRow);
  let paused = false;
  document.getElementById('btn-pause').addEventListener('click', (e) => {
    paused = !paused;
    worker.postMessage({ type: paused ? 'pause' : 'resume' });
    e.target.textContent = paused ? 'Resume' : 'Pause';
  });

  const ro = document.createElement('div');
  ro.id = 'geo-readout'; ro.className = 'readout';
  root.appendChild(ro);
  const vecToggle = document.createElement('label');
  vecToggle.innerHTML = `<input type="checkbox" id="chk-vec"> velocity vectors`;
  root.appendChild(vecToggle);
  updateReadouts();
}

function updateReadouts() {
  const d = derived(params), bad = violations(params).length > 0;
  const ro = document.getElementById('geo-readout');
  ro.className = 'readout' + (bad ? ' bad' : '');
  ro.textContent =
    `length ${d.totalLen.toFixed(1)} / ${CAPS.totalLenMM} mm · ` +
    `exit ${d.exitHeight.toFixed(1)} / ${CAPS.exitHeightMM} mm · ` +
    `${hzFromMdot(mdot).toFixed(1)} Hz`;
}

function reconfigure() {
  document.getElementById('sim-banner').classList.add('hidden');
  sparkHist = [];
  worker.postMessage({ type: 'configure', params, mdot, dxMM, depthMM: 12.7, smag: 0 });
}

function onWorkerMessage(e) {
  const m = e.data;
  if (m.type === 'geometry') { geo = m; return; }
  if (m.type === 'error') { showBanner(`Geometry error: ${m.message}`); return; }
  if (m.type === 'unstable') {
    showBanner('Simulation went unstable — lower the flow rate or coarsen the grid.');
    return;
  }
  if (m.type === 'frame') drawFrame(m);
}

function showBanner(text) {
  const b = document.getElementById('sim-banner');
  b.textContent = text; b.classList.remove('hidden');
}

function cmap(t) { // 0..1 -> deep blue → cyan → yellow → red
  const stops = [[15, 25, 80], [30, 160, 220], [240, 220, 60], [230, 50, 40]];
  const s = Math.min(0.9999, Math.max(0, t)) * (stops.length - 1);
  const k = Math.floor(s), f = s - k;
  return [0, 1, 2].map(i => Math.round(stops[k][i] + f * (stops[k + 1][i] - stops[k][i])));
}

function drawFrame(m) {
  if (!geo) return;
  const { nx, ny, mask } = geo;
  const canvas = document.getElementById('field-canvas');
  const ctx = canvas.getContext('2d');
  const img = new ImageData(nx, ny);
  for (let c = 0; c < nx * ny; c++) {
    const o = c * 4;
    if (mask[c] === SOLID) { img.data[o] = img.data[o + 1] = img.data[o + 2] = 58; }
    else {
      const [r, g, b] = cmap(m.speed[c] / 255);
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b;
    }
    img.data[o + 3] = 255;
  }
  const off = new OffscreenCanvas(nx, ny);
  off.getContext('2d').putImageData(img, 0, 0);
  const scale = Math.min(canvas.width / nx, canvas.height / ny);
  ctx.fillStyle = '#0c0d10'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, 0, nx * scale, ny * scale);
  if (document.getElementById('chk-vec').checked) {
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    const v = m.vec, L = v.stride * scale * 0.8 / m.maxSpeed;
    for (let j = 0; j < v.ny; j++) for (let i = 0; i < v.nx; i++) {
      const ux = v.ux[j * v.nx + i], uy = v.uy[j * v.nx + i];
      if (ux === 0 && uy === 0) continue;
      const x0 = i * v.stride * scale, y0 = j * v.stride * scale;
      ctx.moveTo(x0, y0); ctx.lineTo(x0 + ux * L, y0 + uy * L);
    }
    ctx.stroke();
  }
  drawProfile(m);
  drawScore(m.score);
  const s = m.stats;
  const reTxt = s.warnings.includes('reynolds-capped')
    ? `Re ${s.re} → <b>${s.reEff}</b> (grid-limited)` : `Re ${s.re}`;
  const inflowTxt = s.mdotMeasured == null
    ? `inflow ${s.mdotSet.toFixed(1)} g/s (set)`
    : `inflow <b>${s.mdotMeasured.toFixed(2)}</b> / ${s.mdotSet.toFixed(1)} g/s`;
  document.getElementById('sim-stats').innerHTML =
    `<span>${reTxt}</span><span>${inflowTxt}</span>` +
    `<span>u_lat ${s.mach}</span><span>τ ${s.tau}</span>` +
    `<span>${s.stepsPerSec} steps/s</span><span>t = ${s.tPhys} s</span>` +
    `<span>mass Δ ${s.massErrPct}%</span>` +
    (s.averaging ? '' : '<span style="color:#fb5">developing…</span>');
}

function drawProfile(m) {
  const c = document.getElementById('profile-canvas'), ctx = c.getContext('2d');
  ctx.fillStyle = '#0c0d10'; ctx.fillRect(0, 0, c.width, c.height);
  const inst = m.profile.u;
  if (!inst.length) return;
  let umax = 1e-9;
  for (const v of inst) umax = Math.max(umax, Math.abs(v));
  if (m.avgProfile) for (const v of m.avgProfile.u) umax = Math.max(umax, Math.abs(v));
  const sx = (v) => c.width / 2 + (v / (umax * 1.1)) * (c.width / 2 - 12);
  const line = (u, style, width) => {
    ctx.strokeStyle = style; ctx.lineWidth = width; ctx.beginPath();
    const sy = (k) => 8 + (k / (u.length - 1)) * (c.height - 16);
    for (let k = 0; k < u.length; k++) k ? ctx.lineTo(sx(u[k]), sy(k)) : ctx.moveTo(sx(u[k]), sy(k));
    ctx.stroke();
  };
  // zero line and mean (plug-flow) reference
  ctx.strokeStyle = '#333'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(sx(0), 4); ctx.lineTo(sx(0), c.height - 4); ctx.stroke();
  const ref = m.avgProfile ? m.avgProfile.u : inst;
  let mean = 0; for (const v of ref) mean += v; mean /= ref.length;
  ctx.strokeStyle = '#5c6'; ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.moveTo(sx(mean), 4); ctx.lineTo(sx(mean), c.height - 4); ctx.stroke();
  ctx.setLineDash([]);
  line(inst, 'rgba(106,176,255,0.35)', 1);                      // instantaneous
  if (m.avgProfile) line(m.avgProfile.u, '#6ab0ff', 2);         // time-averaged
  ctx.fillStyle = '#9ab'; ctx.font = '11px system-ui';
  ctx.fillText('exit u(y): faint = instant, bold = averaged, dashed = plug', 10, c.height - 6);
}

function drawScore(score) {
  document.getElementById('score-value').textContent = score == null ? '–' : score.toFixed(3);
  if (score == null) return;
  sparkHist.push(score);
  if (sparkHist.length > 220) sparkHist.shift();
  const c = document.getElementById('score-spark'), ctx = c.getContext('2d');
  ctx.fillStyle = '#0c0d10'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = '#6ab0ff'; ctx.beginPath();
  sparkHist.forEach((v, i) => {
    const x = (i / 219) * c.width, y = c.height - v * (c.height - 4) - 2;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
}
