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
  { key: 's0', label: 's₀ wall', min: 0, max: 1.5, step: 0.05 },
  { key: 's1', label: 's₁ wall', min: 0, max: 1.5, step: 0.05 },
  { key: 'nVanes', label: 'vanes', min: 0, max: 10, step: 1 },
  { key: 'vaneLen', label: 'Lv mm', min: 5, max: 60, step: 1 },
  { key: 'vanePos', label: 'xv mm', min: 0, max: 255, step: 1 },
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

  const fieldRow = document.createElement('div');
  fieldRow.className = 'ctl';
  fieldRow.innerHTML = `<label>field</label><select id="sel-field">
      <option value="speed" selected>speed |u|</option>
      <option value="ux">u (axial)</option>
      <option value="uy">v (vertical)</option>
      <option value="vort">vorticity ω</option></select><span></span>`;
  fieldRow.querySelector('select').addEventListener('change', (e) => {
    worker.postMessage({ type: 'setField', field: e.target.value });
  });
  root.appendChild(fieldRow);

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

function cmapDiv(t) { // 0..1, 0.5 = zero -> cyan-blue | near-bg dark | orange-red
  const neg = [80, 180, 255], mid = [25, 26, 34], pos = [255, 120, 50];
  const [a, b, f] = t < 0.5 ? [mid, neg, (0.5 - t) * 2] : [mid, pos, (t - 0.5) * 2];
  return [0, 1, 2].map(i => Math.round(a[i] + f * (b[i] - a[i])));
}

function buildLut(kind) {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = kind === 'div' ? cmapDiv(i / 255) : cmap(i / 255);
    lut[i * 3] = r; lut[i * 3 + 1] = g; lut[i * 3 + 2] = b;
  }
  return lut;
}
const LUTS = { seq: buildLut('seq'), div: buildLut('div') };

const CBAR_H = 34; // reserved strip at the bottom of the field canvas

function drawColorbar(ctx, W, H, meta) {
  const x0 = W - 260, x1 = W - 40, y0 = H - 24, h = 10;
  const lut = LUTS[meta.kind];
  for (let x = x0; x <= x1; x++) {
    const i = Math.round(((x - x0) / (x1 - x0)) * 255) * 3;
    ctx.fillStyle = `rgb(${lut[i]},${lut[i + 1]},${lut[i + 2]})`;
    ctx.fillRect(x, y0, 1, h);
  }
  ctx.strokeStyle = '#555'; ctx.strokeRect(x0 - 0.5, y0 - 0.5, x1 - x0 + 1, h + 1);
  ctx.fillStyle = '#9ab'; ctx.font = '11px system-ui'; ctx.textAlign = 'center';
  const v = meta.vmaxDisp, fmt = (x) => Math.abs(x) >= 100 ? x.toFixed(0) : x.toPrecision(3);
  if (meta.kind === 'div') {
    ctx.fillText(`-${fmt(v)}`, x0, H - 4);
    ctx.fillText('0', (x0 + x1) / 2, H - 4);
    ctx.fillText(`+${fmt(v)} ${meta.unit}`, x1, H - 4);
  } else {
    ctx.fillText('0', x0, H - 4);
    ctx.fillText(`${fmt(v)} ${meta.unit}`, x1, H - 4);
  }
  const names = { speed: 'speed |u|', ux: 'u (axial)', uy: 'v (vertical)', vort: 'vorticity ω' };
  ctx.textAlign = 'left';
  ctx.fillText(names[meta.mode] || meta.mode, 8, H - 4);
}

function drawFrame(m) {
  if (!geo) return;
  const { nx, ny, mask } = geo;
  const canvas = document.getElementById('field-canvas');
  const ctx = canvas.getContext('2d');
  const lut = LUTS[m.fieldMeta.kind];
  const img = new ImageData(nx, ny);
  for (let c = 0; c < nx * ny; c++) {
    const o = c * 4;
    if (mask[c] === SOLID) { img.data[o] = img.data[o + 1] = img.data[o + 2] = 58; }
    else {
      const i = m.speed[c] * 3;
      img.data[o] = lut[i]; img.data[o + 1] = lut[i + 1]; img.data[o + 2] = lut[i + 2];
    }
    img.data[o + 3] = 255;
  }
  const off = new OffscreenCanvas(nx, ny);
  off.getContext('2d').putImageData(img, 0, 0);
  const scale = Math.min(canvas.width / nx, (canvas.height - CBAR_H) / ny);
  ctx.fillStyle = '#0c0d10'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, 0, nx * scale, ny * scale);
  drawColorbar(ctx, canvas.width, canvas.height, m.fieldMeta);
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

// round a value to a "nice" tick spacing (1/2/5 x 10^n)
function niceStep(range, n) {
  const raw = range / n, mag = 10 ** Math.floor(Math.log10(raw)), r = raw / mag;
  return (r >= 5 ? 5 : r >= 2 ? 2 : 1) * mag;
}

function drawProfile(m) {
  const c = document.getElementById('profile-canvas'), ctx = c.getContext('2d');
  ctx.fillStyle = '#0c0d10'; ctx.fillRect(0, 0, c.width, c.height);
  const inst = m.profile.u;
  if (!inst.length) return;
  const toMMS = m.u2phys * 1000;                 // lattice velocity -> mm/s
  const dxMMg = geo ? geo.dx : 1, ycMM = geo ? geo.yc : 0;
  const instP = Array.from(inst, v => v * toMMS);
  const avgP = m.avgProfile ? Array.from(m.avgProfile.u, v => v * toMMS) : null;
  const ref = avgP || instP;
  let mean = 0; for (const v of ref) mean += v; mean /= ref.length;
  let uMin = 0, uMax = 1e-9;
  for (const v of instP) { uMin = Math.min(uMin, v); uMax = Math.max(uMax, v); }
  if (avgP) for (const v of avgP) { uMin = Math.min(uMin, v); uMax = Math.max(uMax, v); }
  uMax = Math.max(uMax, mean) * 1.12; uMin = Math.min(uMin, 0) * 1.12 - 0.02 * uMax;
  const posMM = Array.from(m.profile.y, (row) => (row + 0.5) * dxMMg - ycMM);
  const yMin = posMM[0], yMax = posMM[posMM.length - 1];
  // plot area
  const ML = 46, MR = 8, MT = 6, MB = 26;
  const PW = c.width - ML - MR, PH = c.height - MT - MB;
  const sx = (u) => ML + ((u - uMin) / (uMax - uMin)) * PW;
  const syPos = (p) => MT + ((p - yMin) / (yMax - yMin)) * PH;
  // axes + ticks
  ctx.strokeStyle = '#3a3f48'; ctx.lineWidth = 1;
  ctx.strokeRect(ML + 0.5, MT + 0.5, PW, PH);
  ctx.fillStyle = '#9ab'; ctx.font = '10px system-ui';
  const ux0 = Math.ceil(uMin / niceStep(uMax - uMin, 5)) * niceStep(uMax - uMin, 5);
  ctx.textAlign = 'center';
  for (let u = ux0; u <= uMax; u += niceStep(uMax - uMin, 5)) {
    const x = sx(u);
    ctx.strokeStyle = '#23262d'; ctx.beginPath();
    ctx.moveTo(x, MT); ctx.lineTo(x, MT + PH); ctx.stroke();
    ctx.fillText(Math.abs(u) < 1e-9 ? '0' : u.toPrecision(2), x, c.height - 14);
  }
  ctx.textAlign = 'right';
  const ys = niceStep(yMax - yMin, 5), py0 = Math.ceil(yMin / ys) * ys;
  for (let p = py0; p <= yMax; p += ys) {
    const y = syPos(p);
    ctx.strokeStyle = '#23262d'; ctx.beginPath();
    ctx.moveTo(ML, y); ctx.lineTo(ML + PW, y); ctx.stroke();
    ctx.fillStyle = '#9ab';
    ctx.fillText(p.toFixed(0), ML - 4, y + 3);
  }
  ctx.textAlign = 'center';
  ctx.fillText('u (mm/s)', ML + PW / 2, c.height - 3);
  ctx.save(); ctx.translate(10, MT + PH / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText('y (mm)', 0, 0); ctx.restore();
  // zero line and plug-flow (mean) reference
  ctx.strokeStyle = '#555'; ctx.beginPath();
  ctx.moveTo(sx(0), MT); ctx.lineTo(sx(0), MT + PH); ctx.stroke();
  ctx.strokeStyle = '#5c6'; ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.moveTo(sx(mean), MT); ctx.lineTo(sx(mean), MT + PH); ctx.stroke();
  ctx.setLineDash([]);
  const line = (arr, style, width) => {
    ctx.strokeStyle = style; ctx.lineWidth = width; ctx.beginPath();
    for (let k = 0; k < arr.length; k++) {
      const x = sx(arr[k]), y = syPos(posMM[k]);
      k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
  };
  line(instP, 'rgba(106,176,255,0.35)', 1);            // instantaneous
  if (avgP) line(avgP, '#6ab0ff', 2);                  // time-averaged
  ctx.textAlign = 'left'; ctx.fillStyle = '#9ab'; ctx.font = '10px system-ui';
  ctx.fillText('faint: instant · bold: avg · dashed: plug', ML + 6, MT + 12);
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
