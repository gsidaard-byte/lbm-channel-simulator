// Shared rendering for simulation tabs: field + colorbar, profile plot, sparkline.
import { SOLID } from './geometry.js';

export function cmap(t) { // 0..1 -> deep blue → cyan → yellow → red
  const stops = [[15, 25, 80], [30, 160, 220], [240, 220, 60], [230, 50, 40]];
  const s = Math.min(0.9999, Math.max(0, t)) * (stops.length - 1);
  const k = Math.floor(s), f = s - k;
  return [0, 1, 2].map(i => Math.round(stops[k][i] + f * (stops[k + 1][i] - stops[k][i])));
}

export function cmapDiv(t) { // 0..1, 0.5 = zero -> cyan-blue | near-bg dark | orange-red
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
export const LUTS = { seq: buildLut('seq'), div: buildLut('div') };

export const CBAR_H = 34; // reserved strip at the bottom of the field canvas

export function drawColorbar(ctx, W, H, meta) {
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

// Field render: colormapped values, solid overlay, porous-screen tint, vectors.
export function renderField(canvas, geo, m, showVectors) {
  const { nx, ny, mask, porous } = geo;
  const ctx = canvas.getContext('2d');
  const lut = LUTS[m.fieldMeta.kind];
  const img = new ImageData(nx, ny);
  for (let c = 0; c < nx * ny; c++) {
    const o = c * 4;
    if (mask[c] === SOLID) { img.data[o] = img.data[o + 1] = img.data[o + 2] = 58; }
    else {
      const i = m.speed[c] * 3;
      let r = lut[i], g = lut[i + 1], b = lut[i + 2];
      if (porous && porous[c] > 0) {          // screens: tint toward white
        const w = 0.35 + 0.4 * porous[c];
        r = r + (235 - r) * w; g = g + (235 - g) * w; b = b + (235 - b) * w;
      }
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b;
    }
    img.data[o + 3] = 255;
  }
  const off = new OffscreenCanvas(nx, ny);
  off.getContext('2d').putImageData(img, 0, 0);
  const scale = Math.min(canvas.width / nx, (canvas.height - CBAR_H) / ny);
  ctx.fillStyle = '#0c0d10'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, 0, nx * scale, ny * scale);
  if (showVectors) {
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
  drawColorbar(ctx, canvas.width, canvas.height, m.fieldMeta);
}

// round a value to a "nice" tick spacing (1/2/5 x 10^n)
export function niceStep(range, n) {
  const raw = range / n, mag = 10 ** Math.floor(Math.log10(raw)), r = raw / mag;
  return (r >= 5 ? 5 : r >= 2 ? 2 : 1) * mag;
}

// Exit-profile plot with physical axes: u [mm/s] vs y [mm from centerline].
export function drawProfilePlot(canvas, m, geo) {
  const c = canvas, ctx = c.getContext('2d');
  ctx.fillStyle = '#0c0d10'; ctx.fillRect(0, 0, c.width, c.height);
  const inst = m.profile.u;
  if (!inst.length) return;
  const toMMS = m.u2phys * 1000;
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
  const ML = 46, MR = 8, MT = 6, MB = 26;
  const PW = c.width - ML - MR, PH = c.height - MT - MB;
  const sx = (u) => ML + ((u - uMin) / (uMax - uMin)) * PW;
  const syPos = (p) => MT + ((p - yMin) / (yMax - yMin)) * PH;
  ctx.strokeStyle = '#3a3f48'; ctx.lineWidth = 1;
  ctx.strokeRect(ML + 0.5, MT + 0.5, PW, PH);
  ctx.fillStyle = '#9ab'; ctx.font = '10px system-ui';
  const xs = niceStep(uMax - uMin, 5), ux0 = Math.ceil(uMin / xs) * xs;
  ctx.textAlign = 'center';
  for (let u = ux0; u <= uMax; u += xs) {
    const x = sx(u);
    ctx.strokeStyle = '#23262d'; ctx.beginPath();
    ctx.moveTo(x, MT); ctx.lineTo(x, MT + PH); ctx.stroke();
    ctx.fillStyle = '#9ab';
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

export function drawSpark(canvas, hist) {
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0c0d10'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#6ab0ff'; ctx.beginPath();
  hist.forEach((v, i) => {
    const x = (i / 219) * canvas.width, y = canvas.height - v * (canvas.height - 4) - 2;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
}

export function statsHtml(s) {
  const reTxt = s.warnings.includes('reynolds-capped')
    ? `Re ${s.re} → <b>${s.reEff}</b> (grid-limited)` : `Re ${s.re}`;
  const inflowTxt = s.mdotMeasured == null
    ? `inflow ${s.mdotSet.toFixed(1)} g/s (set)`
    : `inflow <b>${s.mdotMeasured.toFixed(2)}</b> / ${s.mdotSet.toFixed(1)} g/s`;
  return `<span>${reTxt}</span><span>${inflowTxt}</span>` +
    `<span>u_lat ${s.mach}</span><span>τ ${s.tau}</span>` +
    `<span>${s.stepsPerSec} steps/s</span><span>t = ${s.tPhys} s</span>` +
    `<span>mass Δ ${s.massErrPct}%</span>` +
    (s.dpPa != null && +s.dpPa > 0 ? `<span>Δp ${s.dpPa} Pa</span>` : '') +
    (s.averaging ? '' : '<span style="color:#fb5">developing…</span>');
}
