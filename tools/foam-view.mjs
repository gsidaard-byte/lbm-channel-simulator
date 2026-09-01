// Render an OpenFOAM solution (from foam-case.mjs cases) as a self-contained
// HTML page with the same look as the web app: field views (|U|, u, v, vorticity),
// fixed colorbar, and the exit profile plot.
//
// Prereq: openfoam postProcess -case CASE -func writeCellCentres -latestTime
// Usage:  node tools/foam-view.mjs --case <dir> --time <t> --dx 0.5 --out <file.html> [--title "..."]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).join(' ')
  .split('--').filter(Boolean).map(s => {
    const parts = s.trim().split(/\s+/);
    return [parts[0], parts.slice(1).join(' ')];
  }));
const caseDir = args.case, time = args.time, out = args.out;
const dxMM = parseFloat(args.dx) || 0.5;
if (!caseDir || !time || !out) { console.error('need --case --time --out'); process.exit(1); }

function parseField(file, vector) {
  const s = readFileSync(file, 'utf8');
  const m = s.match(/internalField\s+nonuniform\s+List<(?:vector|scalar)>\s*\n?(\d+)\s*\n?\(([\s\S]*?)\)\s*;/);
  if (!m) throw new Error('cannot parse ' + file);
  const n = +m[1];
  if (vector) {
    const vals = [...m[2].matchAll(/\(([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\)/g)]
      .map(v => [+v[1], +v[2], +v[3]]);
    if (vals.length !== n) throw new Error(`count mismatch ${vals.length}/${n} in ${file}`);
    return vals;
  }
  const vals = m[2].trim().split(/\s+/).map(Number);
  if (vals.length !== n) throw new Error(`count mismatch in ${file}`);
  return vals;
}

const C = parseField(join(caseDir, time, 'C'), true);
const U = parseField(join(caseDir, time, 'U'), true);
let UM = null;
try { UM = parseField(join(caseDir, time, 'UMean'), true); } catch { /* no averaging */ }
const field = UM || U;

// map cells onto the raster grid by centre position (mesh units: meters)
const dxM = dxMM / 1000;
let nx = 0, ny = 0;
const idx = C.map(([x, y]) => {
  const i = Math.round(x / dxM - 0.5), j = Math.round(y / dxM - 0.5);
  nx = Math.max(nx, i + 1); ny = Math.max(ny, j + 1);
  return [i, j];
});
const ux = new Float32Array(nx * ny).fill(NaN), uy = new Float32Array(nx * ny).fill(NaN);
for (let c = 0; c < idx.length; c++) {
  const [i, j] = idx[c];
  const g = (ny - 1 - j) * nx + i;         // flip to screen coords (y down)
  ux[g] = field[c][0]; uy[g] = -field[c][1];   // v positive up on screen
}

const title = args.title || `OpenFOAM ${caseDir.split('/').pop()} t=${time}`;
const data = {
  nx, ny, dxMM, title,
  averaged: !!UM,
  ux: Array.from(ux, v => Number.isFinite(v) ? +v.toPrecision(5) : null),
  uy: Array.from(uy, v => Number.isFinite(v) ? +v.toPrecision(5) : null),
};

writeFileSync(out, `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
body { font: 14px system-ui; background: #14161a; color: #e8e8e8; margin: 16px; }
canvas { background: #0c0d10; border-radius: 6px; }
.row { display: flex; gap: 14px; align-items: center; margin-bottom: 10px; }
select { background: #22252c; color: #eee; border: 1px solid #3a3f48; border-radius: 4px; padding: 4px; }
</style></head><body>
<div class="row"><b>${title}</b>
  <select id="field">
    <option value="speed">speed |u|</option>
    <option value="ux">u (axial)</option>
    <option value="uy">v (vertical)</option>
    <option value="vort">vorticity ω</option>
  </select>
  <span id="note">${UM ? 'iteration-averaged (UMean)' : 'instantaneous'}</span>
</div>
<canvas id="fld" width="1100" height="760"></canvas>
<div class="row"><canvas id="prof" width="480" height="260"></canvas></div>
<script>
const D = ${JSON.stringify(data)};
const { nx, ny } = D;
const ux = D.ux, uy = D.uy;
function cmap(t){const s=[[15,25,80],[30,160,220],[240,220,60],[230,50,40]];const q=Math.min(.9999,Math.max(0,t))*3;const k=Math.floor(q),f=q-k;return [0,1,2].map(i=>Math.round(s[k][i]+f*(s[k+1][i]-s[k][i])));}
function cmapDiv(t){const n=[80,180,255],m=[25,26,34],p=[255,120,50];const [a,b,f]=t<.5?[m,n,(0.5-t)*2]:[m,p,(t-.5)*2];return [0,1,2].map(i=>Math.round(a[i]+f*(b[i]-a[i])));}
let vmax = 0;
for (let c = 0; c < nx*ny; c++) if (ux[c] !== null) vmax = Math.max(vmax, Math.hypot(ux[c], uy[c]));
vmax *= 0.85;   // saturate the extreme jet core a little for visibility
function draw() {
  const mode = document.getElementById('field').value;
  const cv = document.getElementById('fld'), ctx = cv.getContext('2d');
  const img = new ImageData(nx, ny);
  const wmax = vmax / (3 * D.dxMM / 1000);   // 1/s scale for vorticity
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const c = j*nx + i, o = c*4;
    if (ux[c] === null) { img.data[o]=img.data[o+1]=img.data[o+2]=58; img.data[o+3]=255; continue; }
    let rgb;
    if (mode === 'speed') rgb = cmap(Math.hypot(ux[c], uy[c]) / vmax);
    else if (mode === 'ux') rgb = cmapDiv(0.5 + 0.5*ux[c]/vmax);
    else if (mode === 'uy') rgb = cmapDiv(0.5 + 0.5*uy[c]/vmax);
    else {
      const l=c-1, r=c+1, u2=c-nx, d=c+nx;
      let w = 0;
      if (i>0 && i<nx-1 && j>0 && j<ny-1 && ux[l]!==null && ux[r]!==null && ux[u2]!==null && ux[d]!==null)
        w = -(((uy[r]-uy[l])/2 - (ux[d]-ux[u2])/2) / (D.dxMM/1000));
      rgb = cmapDiv(0.5 + 0.5*w/wmax);
    }
    img.data[o]=rgb[0]; img.data[o+1]=rgb[1]; img.data[o+2]=rgb[2]; img.data[o+3]=255;
  }
  const off = document.createElement('canvas'); off.width = nx; off.height = ny;
  off.getContext('2d').putImageData(img, 0, 0);
  const scale = Math.min(cv.width/nx, (cv.height-34)/ny);
  ctx.fillStyle = '#0c0d10'; ctx.fillRect(0,0,cv.width,cv.height);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, 0, nx*scale, ny*scale);
  // colorbar
  const x0 = cv.width-280, x1 = cv.width-60, y0 = cv.height-24;
  for (let x = x0; x <= x1; x++) {
    const t = (x-x0)/(x1-x0);
    const rgb = (mode==='speed'?cmap:cmapDiv)(t);
    ctx.fillStyle = 'rgb('+rgb.join(',')+')'; ctx.fillRect(x, y0, 1, 10);
  }
  ctx.fillStyle = '#9ab'; ctx.font = '11px system-ui'; ctx.textAlign = 'center';
  const disp = mode==='vort' ? [wmax.toFixed(1), '1/s'] : [(vmax*1000).toFixed(1), 'mm/s'];
  if (mode === 'speed') { ctx.fillText('0', x0, cv.height-4); ctx.fillText(disp[0]+' '+disp[1], x1, cv.height-4); }
  else { ctx.fillText('-'+disp[0], x0, cv.height-4); ctx.fillText('0', (x0+x1)/2, cv.height-4); ctx.fillText('+'+disp[0]+' '+disp[1], x1, cv.height-4); }
  ctx.textAlign = 'left'; ctx.fillText(mode, 8, cv.height-4);
  drawProfile();
}
function drawProfile() {
  // exit profile: last column with data before the right numerical buffer edge
  const cv = document.getElementById('prof'), ctx = cv.getContext('2d');
  ctx.fillStyle = '#0c0d10'; ctx.fillRect(0,0,cv.width,cv.height);
  let col = nx - 1;
  outer: for (; col >= 0; col--) for (let j = 0; j < ny; j++) if (ux[j*nx+col] !== null) break outer;
  col = col - 19;  // step upstream of the 18-col buffer to the physical exit
  const ys = [], us = [];
  for (let j = 0; j < ny; j++) if (ux[j*nx+col] !== null) { ys.push(j); us.push(ux[j*nx+col]*1000); }
  const uMin = Math.min(0, ...us)*1.1, uMax = Math.max(...us)*1.1;
  const ML = 48, MB = 24, PW = cv.width-ML-10, PH = cv.height-MB-8;
  const sx = u => ML + (u-uMin)/(uMax-uMin)*PW;
  const sy = k => 8 + k/(us.length-1)*PH;
  ctx.strokeStyle = '#3a3f48'; ctx.strokeRect(ML+.5, 8.5, PW, PH);
  const mean = us.reduce((s,v)=>s+v,0)/us.length;
  ctx.strokeStyle = '#5c6'; ctx.setLineDash([5,4]);
  ctx.beginPath(); ctx.moveTo(sx(mean),8); ctx.lineTo(sx(mean),8+PH); ctx.stroke(); ctx.setLineDash([]);
  ctx.strokeStyle = '#555'; ctx.beginPath(); ctx.moveTo(sx(0),8); ctx.lineTo(sx(0),8+PH); ctx.stroke();
  ctx.strokeStyle = '#6ab0ff'; ctx.lineWidth = 2; ctx.beginPath();
  us.forEach((u,k)=> k?ctx.lineTo(sx(u),sy(k)):ctx.moveTo(sx(u),sy(k))); ctx.stroke();
  ctx.lineWidth = 1; ctx.fillStyle = '#9ab'; ctx.font = '10px system-ui'; ctx.textAlign='center';
  for (const u of [0, mean, uMax/1.1]) ctx.fillText(u.toFixed(1), sx(u), cv.height-10);
  ctx.fillText('exit u (mm/s) — dashed: plug', ML+PW/2, cv.height-1);
  const sd = Math.sqrt(us.reduce((s,v)=>s+(v-mean)**2,0)/us.length);
  ctx.textAlign='left';
  ctx.fillText('uniformity ' + Math.max(0,1-sd/mean).toFixed(3), ML+6, 20);
}
document.getElementById('field').addEventListener('change', draw);
draw();
</script></body></html>
`);
console.log('wrote', out, `(${nx}x${ny}, ${idx.length} cells, ${UM ? 'UMean' : 'U'})`);
