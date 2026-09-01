// Advanced tab: flow-conditioning design (bend vanes, cambered rows, screens).
// Inlet, exit, and total length are fixed; uniformity comes from conditioning.
import { ADV_DEFAULTS, advClamp } from './geometry-adv.js';
import { MDOT_MIN, MDOT_MAX, hzFromMdot } from './units.js';
import { renderField, drawProfilePlot, drawSpark, statsHtml } from './viz.js';

const SLIDERS = [
  { key: 'th', label: 'throat', min: 8, max: 40, step: 0.5 },
  { key: 'tl', label: 'thr len', min: 5, max: 40, step: 0.5 },
  { key: 'Lexp', label: 'Lexp', min: 60, max: 186, step: 1 },
  { key: 's0', label: 's₀ wall', min: 0, max: 1.5, step: 0.05 },
  { key: 's1', label: 's₁ wall', min: 0, max: 1.5, step: 0.05 },
  { key: 'bendVanes', label: 'bend v.', min: 0, max: 4, step: 1 },
  { key: 'r1n', label: 'row1 n', min: 0, max: 12, step: 1 },
  { key: 'r1x', label: 'row1 x', min: 3, max: 180, step: 1 },
  { key: 'r1c', label: 'row1 c', min: 8, max: 60, step: 1 },
  { key: 'r2n', label: 'row2 n', min: 0, max: 16, step: 1 },
  { key: 'r2x', label: 'row2 x', min: 3, max: 180, step: 1 },
  { key: 'r2c', label: 'row2 c', min: 8, max: 60, step: 1 },
  { key: 'sc1x', label: 'scr1 x', min: 5, max: 195, step: 1 },
  { key: 'sc1s', label: 'scr1 σ', min: 0, max: 0.9, step: 0.05 },
  { key: 'sc1g', label: 'scr1 slot', min: 2, max: 8, step: 0.5 },
  { key: 'sc2x', label: 'scr2 x', min: 5, max: 195, step: 1 },
  { key: 'sc2s', label: 'scr2 σ', min: 0, max: 0.9, step: 0.05 },
  { key: 'sc2g', label: 'scr2 slot', min: 2, max: 8, step: 0.5 },
];
const RES = { coarse: 1.0, medium: 0.5, fine: 0.35 };
const INT_KEYS = new Set(['bendVanes', 'r1n', 'r2n']);

let worker = null, params = { ...ADV_DEFAULTS }, mdot = 6e-3, dxMM = RES.coarse;
let geo = null, debounceT = 0, sparkHist = [], els = {};
let started = false, manualPause = false, autoPaused = false;

export function init() {
  buildControls();
}

export function setActive(active) {
  if (active && !started) {           // lazy start on first activation
    started = true;
    worker = new Worker('./js/sim-worker.js', { type: 'module' });
    worker.onmessage = onWorkerMessage;
    reconfigure();
    return;
  }
  if (!worker) return;
  if (!active && !manualPause) { worker.postMessage({ type: 'pause' }); autoPaused = true; }
  else if (active && autoPaused) { worker.postMessage({ type: 'resume' }); autoPaused = false; }
}

function buildControls() {
  const root = document.getElementById('adv-controls');
  for (const s of SLIDERS) {
    const row = document.createElement('div');
    row.className = 'ctl';
    row.innerHTML = `<label>${s.label}</label>
      <input type="range" min="${s.min}" max="${s.max}" step="${s.step}" value="${params[s.key]}">
      <input type="number" min="${s.min}" max="${s.max}" step="${s.step}" value="${params[s.key]}">`;
    const [range, num] = row.querySelectorAll('input');
    const onChange = (v) => {
      params[s.key] = INT_KEYS.has(s.key) ? Math.round(+v) : +v;
      params = advClamp(params);
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
    <button class="action" id="btn-pause-adv">Pause</button>`;
  resRow.querySelector('select').addEventListener('change', (e) => {
    dxMM = RES[e.target.value]; reconfigure();
  });
  root.appendChild(resRow);
  document.getElementById('btn-pause-adv').addEventListener('click', (e) => {
    manualPause = !manualPause;
    worker?.postMessage({ type: manualPause ? 'pause' : 'resume' });
    e.target.textContent = manualPause ? 'Resume' : 'Pause';
  });

  const fieldRow = document.createElement('div');
  fieldRow.className = 'ctl';
  fieldRow.innerHTML = `<label>field</label><select id="sel-field-adv">
      <option value="speed" selected>speed |u|</option>
      <option value="ux">u (axial)</option>
      <option value="uy">v (vertical)</option>
      <option value="vort">vorticity ω</option></select><span></span>`;
  fieldRow.querySelector('select').addEventListener('change', (e) => {
    worker?.postMessage({ type: 'setField', field: e.target.value });
  });
  root.appendChild(fieldRow);

  const modeRow = document.createElement('div');
  modeRow.className = 'ctl';
  modeRow.innerHTML = `<label>screens</label><select id="sel-scrmode">
      <option value="plate" selected>printable plates (ribs)</option>
      <option value="porous">ideal porous (mesh)</option></select><span></span>`;
  modeRow.querySelector('select').addEventListener('change', (e) => {
    params.scrMode = e.target.value;
    reconfigure();
  });
  root.appendChild(modeRow);

  const ro = document.createElement('div');
  ro.id = 'adv-readout'; ro.className = 'readout';
  root.appendChild(ro);
  const vecToggle = document.createElement('label');
  vecToggle.innerHTML = `<input type="checkbox" id="chk-vec-adv"> velocity vectors`;
  root.appendChild(vecToggle);
  updateReadouts();
}

function updateReadouts() {
  let ribs = '';
  if (params.scrMode !== 'porous') {
    const dims = (s, g) => s > 0 ? `slot ${g.toFixed(1)}/rib ${(g / (1 - s) - g).toFixed(1)}` : 'off';
    ribs = ` · print: scr1 ${dims(params.sc1s, params.sc1g)} · scr2 ${dims(params.sc2s, params.sc2g)} mm`;
  }
  document.getElementById('adv-readout').textContent =
    `inlet 12.7 · exit 203.2 · length 228.6 mm (fixed) · ${hzFromMdot(mdot).toFixed(1)} Hz${ribs}`;
}

function reconfigure() {
  if (!worker) return;
  document.getElementById('adv-banner').classList.add('hidden');
  sparkHist = [];
  worker.postMessage({ type: 'configure', design: 'advanced', params, mdot, dxMM, depthMM: 12.7, smag: 0 });
}

function onWorkerMessage(e) {
  const m = e.data;
  if (m.type === 'geometry') { geo = m; return; }
  if (m.type === 'error') { showBanner(`Geometry error: ${m.message}`); return; }
  if (m.type === 'unstable') {
    showBanner('Simulation went unstable — lower the flow rate or reduce vane counts.');
    return;
  }
  if (m.type === 'frame') drawFrame(m);
}

function showBanner(text) {
  const b = document.getElementById('adv-banner');
  b.textContent = text; b.classList.remove('hidden');
}

function drawFrame(m) {
  if (!geo) return;
  renderField(document.getElementById('field-canvas-adv'), geo, m,
              document.getElementById('chk-vec-adv').checked);
  drawProfilePlot(document.getElementById('profile-canvas-adv'), m, geo);
  document.getElementById('score-value-adv').textContent = m.score == null ? '–' : m.score.toFixed(3);
  if (m.score != null) {
    sparkHist.push(m.score);
    if (sparkHist.length > 220) sparkHist.shift();
    drawSpark(document.getElementById('score-spark-adv'), sparkHist);
  }
  document.getElementById('adv-stats').innerHTML = statsHtml(m.stats);
}
