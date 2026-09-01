// Simulate tab: sliders for the classic parameterized channel + shared viz.
import { DEFAULT_PARAMS, CAPS, derived, violations, clampParams } from './geometry.js';
import { MDOT_MIN, MDOT_MAX, MDOT_CAL_MAX, hzFromMdot } from './units.js';
import { renderField, drawProfilePlot, drawSpark, statsHtml } from './viz.js';

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
let manualPause = false, autoPaused = false;

export function init() {
  buildControls();
  worker = new Worker('./js/sim-worker.js', { type: 'module' });
  worker.onmessage = onWorkerMessage;
  reconfigure();
}

export function setActive(active) {
  if (!worker) return;
  if (!active && !manualPause) { worker.postMessage({ type: 'pause' }); autoPaused = true; }
  else if (active && autoPaused) { worker.postMessage({ type: 'resume' }); autoPaused = false; }
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
  document.getElementById('btn-pause').addEventListener('click', (e) => {
    manualPause = !manualPause;
    worker.postMessage({ type: manualPause ? 'pause' : 'resume' });
    e.target.textContent = manualPause ? 'Resume' : 'Pause';
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
    `${hzFromMdot(mdot).toFixed(1)} Hz` +
    (mdot > MDOT_CAL_MAX ? ' (beyond meter cal.)' : '');
}

function reconfigure() {
  document.getElementById('sim-banner').classList.add('hidden');
  sparkHist = [];
  worker.postMessage({ type: 'configure', design: 'classic', params, mdot, dxMM, depthMM: 12.7, smag: 0 });
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

function drawFrame(m) {
  if (!geo) return;
  renderField(document.getElementById('field-canvas'), geo, m,
              document.getElementById('chk-vec').checked);
  drawProfilePlot(document.getElementById('profile-canvas'), m, geo);
  document.getElementById('score-value').textContent = m.score == null ? '–' : m.score.toFixed(3);
  if (m.score != null) {
    sparkHist.push(m.score);
    if (sparkHist.length > 220) sparkHist.shift();
    drawSpark(document.getElementById('score-spark'), sparkHist);
  }
  document.getElementById('sim-stats').innerHTML = statsHtml(m.stats);
}
