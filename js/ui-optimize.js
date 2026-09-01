// Optimize tab: choose free parameters, run Nelder-Mead in a worker, track results.
import { buildMask, SOLID } from './geometry.js';

const OPTIMIZABLE = [
  { key: 'd2', lo: 6, hi: 40 }, { key: 'd3', lo: 5, hi: 60 }, { key: 'd4', lo: 8, hi: 40 },
  { key: 'd5', lo: 40, hi: 200 }, { key: 'd6', lo: 8, hi: 60 },
  { key: 'theta1', lo: 3, hi: 40 }, { key: 'theta2', lo: 0, hi: 45 },
  { key: 's0', lo: 0, hi: 1.5 }, { key: 's1', lo: 0, hi: 1.5 },
  { key: 'nVanes', lo: 0, hi: 10 },
  { key: 'vaneLen', lo: 5, hi: 60 }, { key: 'vanePos', lo: 0, hi: 235 },
];
const OPT_DX = 1.5;   // coarse grid for objective evaluations

let worker = null, running = false, rows = [], bestRow = null, hooks = null;
let convHist = [], freeKeys = null;

export function init(h) {
  hooks = h;
  const root = document.getElementById('opt-controls');
  root.innerHTML = `<div id="opt-free"></div>
    <div class="ctl"><label>flow</label>
      <select id="opt-flow">
        <option value="mid" selected>6.9 g/s (mid)</option>
        <option value="low">2.3 g/s (low)</option>
        <option value="high">11.5 g/s (high)</option>
        <option value="avg3">average of 3</option>
      </select><span></span></div>
    <div class="ctl"><label>evals</label>
      <input type="number" id="opt-maxeval" value="60" min="10" max="400"><span></span></div>
    <div class="ctl"><label>starts</label>
      <input type="number" id="opt-starts" value="1" min="1" max="5"><span></span></div>
    <button class="action" id="opt-run">Run optimization</button>
    <button class="action" id="opt-send" disabled>Send best to Simulate</button>
    <button class="action" id="opt-csv" disabled>Export CSV</button>`;
  const freeDiv = document.getElementById('opt-free');
  for (const o of OPTIMIZABLE) {
    const row = document.createElement('div');
    row.className = 'ctl';
    row.innerHTML = `<label><input type="checkbox" data-key="${o.key}"
        ${['theta1', 'theta2', 'd5'].includes(o.key) ? 'checked' : ''}> ${o.key}</label>
      <input type="number" value="${o.lo}" data-lo> <input type="number" value="${o.hi}" data-hi>`;
    freeDiv.appendChild(row);
  }
  document.getElementById('opt-run').addEventListener('click', toggleRun);
  document.getElementById('opt-send').addEventListener('click', () => {
    if (bestRow) hooks.sendToSimulate(bestRow.params);
  });
  document.getElementById('opt-csv').addEventListener('click', exportCsv);
  const thead = document.querySelector('#opt-table thead');
  thead.innerHTML = '<tr><th>#</th>' + OPTIMIZABLE.map(o => `<th>${o.key}</th>`).join('') +
    '<th>score</th></tr>';
}

function selectedFlows() {
  const v = document.getElementById('opt-flow').value;
  return { mid: [6.9e-3], low: [2.3e-3], high: [11.5e-3], avg3: [2.3e-3, 6.9e-3, 11.5e-3] }[v];
}

function toggleRun() {
  const btn = document.getElementById('opt-run');
  if (running) { worker.postMessage({ type: 'cancel' }); return; }
  const free = [...document.querySelectorAll('#opt-free .ctl')].flatMap(row => {
    const cb = row.querySelector('input[type=checkbox]');
    if (!cb.checked) return [];
    return [{ key: cb.dataset.key,
              lo: +row.querySelector('[data-lo]').value,
              hi: +row.querySelector('[data-hi]').value }];
  });
  if (!free.length) { setStatus('Select at least one free parameter.'); return; }
  rows = []; convHist = []; bestRow = null; freeKeys = free.map(f => f.key);
  document.querySelector('#opt-table tbody').innerHTML = '';
  worker?.terminate();
  worker = new Worker('./js/opt-worker.js', { type: 'module' });
  worker.onmessage = onMsg;
  worker.postMessage({ type: 'start', base: hooks.getParams(), free,
                       mdots: selectedFlows(), dxMM: OPT_DX, depthMM: 12.7,
                       maxEval: +document.getElementById('opt-maxeval').value,
                       starts: +document.getElementById('opt-starts').value });
  running = true; btn.textContent = 'Cancel';
  setStatus('Running…');
}

function onMsg(e) {
  const m = e.data;
  if (m.type === 'eval') {
    convHist.push(Math.max(m.score, convHist.length ? convHist[convHist.length - 1] : 0));
    addRow(m);
    drawConvergence();
    setStatus(`eval ${m.evals} · score ${m.score.toFixed(3)} · best ${bestRow ? bestRow.score.toFixed(3) : '–'}`);
  } else if (m.type === 'best') {
    bestRow = m;
    document.getElementById('opt-send').disabled = false;
    document.getElementById('opt-csv').disabled = false;
    drawThumb(m.params);
  } else if (m.type === 'done') {
    running = false;
    document.getElementById('opt-run').textContent = 'Run optimization';
    setStatus(m.best.params
      ? `Done after ${m.evals} evaluations. Best score ${m.best.score.toFixed(3)}.`
      : 'Done — no stable configuration found.');
  } else if (m.type === 'error') {
    running = false;
    document.getElementById('opt-run').textContent = 'Run optimization';
    setStatus(`Error: ${m.message}`);
  }
}

function addRow(m) {
  rows.push(m);
  const tb = document.querySelector('#opt-table tbody');
  const tr = document.createElement('tr');
  const vals = OPTIMIZABLE.map(o => {
    const idx = freeKeys.indexOf(o.key);
    return idx >= 0 && m.x ? (+m.x[idx]).toFixed(1) : '·';
  });
  tr.innerHTML = `<td>${m.evals}</td>` + vals.map(v => `<td>${v}</td>`).join('') +
    `<td>${m.score.toFixed(3)}</td>`;
  if (bestRow && Math.abs(m.score - bestRow.score) < 1e-9) tr.className = 'best';
  tb.prepend(tr);
  while (tb.children.length > 150) tb.lastChild.remove();
}

function setStatus(t) { document.getElementById('opt-status').textContent = t; }

function drawConvergence() {
  const c = document.getElementById('opt-convergence'), ctx = c.getContext('2d');
  ctx.fillStyle = '#0c0d10'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = '#6ab0ff'; ctx.beginPath();
  convHist.forEach((v, i) => {
    const x = 10 + (i / Math.max(1, convHist.length - 1)) * (c.width - 20);
    const y = c.height - 10 - v * (c.height - 20);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = '#9ab'; ctx.font = '11px system-ui';
  ctx.fillText('best uniformity vs evaluation', 12, 14);
}

function drawThumb(params) {
  const g = buildMask(params, 1.5);
  if (!g.ok) return;
  const c = document.getElementById('opt-thumb'), ctx = c.getContext('2d');
  const img = new ImageData(g.nx, g.ny);
  for (let i = 0; i < g.mask.length; i++) {
    const o = i * 4, solid = g.mask[i] === SOLID;
    img.data[o] = solid ? 40 : 90; img.data[o + 1] = solid ? 42 : 150;
    img.data[o + 2] = solid ? 48 : 230; img.data[o + 3] = 255;
  }
  const off = new OffscreenCanvas(g.nx, g.ny);
  off.getContext('2d').putImageData(img, 0, 0);
  ctx.fillStyle = '#0c0d10'; ctx.fillRect(0, 0, c.width, c.height);
  const s = Math.min(c.width / g.nx, c.height / g.ny);
  ctx.drawImage(off, 0, 0, g.nx * s, g.ny * s);
}

function exportCsv() {
  const lines = [['eval', ...freeKeys, 'score'].join(',')];
  for (const r of rows) lines.push([r.evals, ...(r.x || []).map(v => (+v).toFixed(3)), r.score.toFixed(4)].join(','));
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(lines.join('\n'));
  a.download = 'optimization.csv';
  a.click();
}
