# Interactive LBM Channel Simulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single-page browser app that simulates the 2D water channel (inlet duct → turn/contraction → throat → diffuser → guide vanes → exit) with a D2Q9 TRT lattice Boltzmann solver in a Web Worker, live sliders for the 8 geometric parameters + vane count + mass flow, a live exit-uniformity score, and an Optimize tab running Nelder–Mead over user-selected parameters.

**Architecture:** Pure ES modules (`lbm.js`, `geometry.js`, `units.js`, `optimizer.js`) shared by two module Workers (`sim-worker.js` interactive, `opt-worker.js` headless) and two UI modules. No build tooling; served by any static HTTP server (module workers do not load from `file://`). Node test script validates the pure modules.

**Tech Stack:** Vanilla JS (ES2022 modules), Canvas 2D, Web Workers, Node ≥ 18 for tests. No dependencies.

**Spec:** `docs/superpowers/specs/2026-08-31-lbm-channel-simulator-design.md`

**Deviations from spec (deliberate, small):**
1. Total-length cap is enforced as `d1+d2+d3+d5+d6 ≤ 228.6 mm` (the spec formula omitted d₁; "start to end" includes the duct).
2. Outlet BC: zero-gradient copy + density renormalization to ρ=1 (simpler than anti-bounce-back, same pressure-anchoring effect).
3. Solver validation: Taylor–Green vortex decay (collision/viscosity) + wall-bounded shear-mode decay (bounce-back) + full-geometry integration test (BCs, mass conservation), instead of a forced Poiseuille test — our solver needs no body-force term and adding one just for a test violates YAGNI.
4. `optimizer.js` is its own pure module (testable), imported by `opt-worker.js`.

**Grid/coordinate conventions (used everywhere):**
- Grid index `(x, y)`: `x` = column (0 = left), `y` = row (0 = top). Screen-down = +y. Inlet flow is +y (downward) at the top row; outlet is the rightmost column.
- Cell `(x,y)` ↔ physical mm: `xmm = (x + 0.5)*dx − margin*dx`, `ymm = (y + 0.5)*dx` (dx in mm, `margin` = 2 solid cells added on the left only).
- Mask codes: `SOLID=0, FLUID=1, INLET=2, OUTLET=3`. Out-of-bounds is treated as solid by the solver.
- D2Q9 order: `0:(0,0) 1:(1,0) 2:(0,1) 3:(-1,0) 4:(0,-1) 5:(1,1) 6:(-1,1) 7:(-1,-1) 8:(1,-1)`, weights `4/9, 1/9×4, 1/36×4`, `OPP=[0,3,4,1,2,7,8,5,6]`.

---

### Task 1: Scaffold + test harness

**Files:**
- Create: `package.json`, `index.html`, `css/style.css`, `test/harness.mjs`, `test/run-tests.mjs`, `README.md`

- [ ] **Step 1: Create `package.json`** (enables ESM in Node tests)

```json
{
  "name": "lbm-channel-simulator",
  "private": true,
  "type": "module",
  "scripts": { "test": "node test/run-tests.mjs", "serve": "python3 -m http.server 8123" }
}
```

- [ ] **Step 2: Create `test/harness.mjs`**

```js
export const tests = [];
export function test(name, fn) { tests.push({ name, fn }); }
export function ok(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }
export function approx(actual, expected, tol, msg = '') {
  if (!(Math.abs(actual - expected) <= tol))
    throw new Error(`${msg} expected ${expected}±${tol}, got ${actual}`);
}
```

- [ ] **Step 3: Create `test/run-tests.mjs`**

```js
import { tests } from './harness.mjs';
const mods = ['./units.test.mjs', './geometry.test.mjs', './lbm.test.mjs', './optimizer.test.mjs'];
for (const m of mods) {
  try { await import(m); }
  catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
}
let fail = 0;
for (const t of tests) {
  try { await t.fn(); console.log('PASS', t.name); }
  catch (e) { fail++; console.error('FAIL', t.name, '-', e.message); }
}
console.log(`${tests.length - fail}/${tests.length} passed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 4: Create `index.html`** (static shell; UI modules arrive in Tasks 10/12)

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LBM Channel Simulator</title>
<link rel="stylesheet" href="css/style.css">
</head>
<body>
<header>
  <h1>LBM Channel Simulator</h1>
  <nav>
    <button id="tab-simulate" class="tab active">Simulate</button>
    <button id="tab-optimize" class="tab">Optimize</button>
  </nav>
</header>
<main>
  <section id="panel-simulate" class="panel active">
    <div id="sim-controls" class="controls"></div>
    <div class="viz">
      <div id="sim-banner" class="banner hidden"></div>
      <canvas id="field-canvas" width="920" height="560"></canvas>
      <div class="viz-row">
        <canvas id="profile-canvas" width="460" height="220"></canvas>
        <div id="score-box">
          <div class="score-label">Exit uniformity</div>
          <div id="score-value">–</div>
          <canvas id="score-spark" width="220" height="48"></canvas>
        </div>
      </div>
      <div id="sim-stats" class="stats"></div>
    </div>
  </section>
  <section id="panel-optimize" class="panel">
    <div id="opt-controls" class="controls"></div>
    <div class="viz">
      <div class="viz-row">
        <canvas id="opt-convergence" width="460" height="240"></canvas>
        <canvas id="opt-thumb" width="380" height="240"></canvas>
      </div>
      <div id="opt-status" class="stats"></div>
      <div id="opt-table-wrap"><table id="opt-table"><thead></thead><tbody></tbody></table></div>
    </div>
  </section>
</main>
<script type="module">
  const tabs = { simulate: null, optimize: null };
  for (const name of ['simulate', 'optimize']) {
    document.getElementById(`tab-${name}`).addEventListener('click', () => {
      document.querySelectorAll('.tab, .panel').forEach(el => el.classList.remove('active'));
      document.getElementById(`tab-${name}`).classList.add('active');
      document.getElementById(`panel-${name}`).classList.add('active');
    });
  }
  const sim = await import('./js/ui-simulate.js').catch(() => null);
  const opt = await import('./js/ui-optimize.js').catch(() => null);
  if (sim) sim.init();
  if (opt && sim) opt.init({ sendToSimulate: sim.setParams, getParams: sim.getParams });
</script>
</body>
</html>
```

- [ ] **Step 5: Create `css/style.css`**

```css
* { box-sizing: border-box; margin: 0; }
body { font: 14px/1.45 system-ui, sans-serif; background: #14161a; color: #e8e8e8; }
header { display: flex; align-items: center; gap: 24px; padding: 10px 16px; background: #1d2026; }
h1 { font-size: 16px; font-weight: 600; }
.tab { background: none; border: 1px solid #3a3f48; color: #aaa; padding: 6px 16px; border-radius: 6px; cursor: pointer; }
.tab.active { color: #fff; border-color: #6ab0ff; }
.panel { display: none; padding: 12px 16px; gap: 16px; }
.panel.active { display: flex; }
.controls { width: 330px; flex: none; display: flex; flex-direction: column; gap: 8px; }
.viz { flex: 1; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.viz-row { display: flex; gap: 12px; align-items: flex-start; }
canvas { background: #0c0d10; border-radius: 6px; max-width: 100%; }
.ctl { display: grid; grid-template-columns: 52px 1fr 74px; gap: 8px; align-items: center; }
.ctl label { color: #9ab; }
.ctl input[type=number] { width: 74px; background: #22252c; color: #eee; border: 1px solid #3a3f48; border-radius: 4px; padding: 3px 5px; }
.ctl input[type=range] { width: 100%; }
.stats { color: #9ab; font-size: 13px; display: flex; flex-wrap: wrap; gap: 14px; }
.banner { background: #7a2c2c; padding: 8px 12px; border-radius: 6px; }
.hidden { display: none; }
button.action { background: #2b5c9b; border: 0; color: #fff; padding: 8px 14px; border-radius: 6px; cursor: pointer; }
button.action[disabled] { opacity: .5; }
.readout { color: #8fa; font-size: 13px; }
.readout.bad { color: #f88; }
#score-value { font-size: 34px; font-weight: 700; color: #6ab0ff; }
#opt-table-wrap { max-height: 300px; overflow: auto; }
table { border-collapse: collapse; font-size: 12px; width: 100%; }
td, th { border: 1px solid #333; padding: 3px 7px; text-align: right; }
tr.best { background: #1d3a25; }
```

- [ ] **Step 6: Create `README.md`**

```markdown
# LBM Channel Simulator

Interactive D2Q9 lattice Boltzmann simulation of a 2D water channel
(inlet duct → contraction → throat → wide-angle diffuser → guide vanes → exit)
with live geometry sliders and exit-uniformity optimization.

## Run
    python3 -m http.server 8123
then open http://localhost:8123 (module workers do not work over file://).

## Test
    npm test

Spec: docs/superpowers/specs/2026-08-31-lbm-channel-simulator-design.md
```

- [ ] **Step 7: Run the (empty) test suite**

Run: `npm test`
Expected: `0/0 passed`, exit code 0.

- [ ] **Step 8: Commit**

```bash
git add package.json index.html css/style.css test/harness.mjs test/run-tests.mjs README.md
git commit -m "feat: scaffold app shell and test harness"
```

---

### Task 2: units.js — physical ↔ lattice conversions

**Files:**
- Create: `js/units.js`
- Test: `test/units.test.mjs`

- [ ] **Step 1: Write failing tests** — create `test/units.test.mjs`:

```js
import { test, ok, approx } from './harness.mjs';
import { RHO, NU, inletVelocity, throatReynolds, hzFromMdot, mdotFromHz, latticeParams }
  from '../js/units.js';

test('inlet velocity from mass flow', () => {
  // 6 g/s of water through 12.7mm x 12.7mm duct
  const u = inletVelocity(6e-3, 0.0127, 0.0127);
  approx(u, 6e-3 / (1000 * 0.0127 * 0.0127), 1e-12);
});

test('throat Reynolds independent of d4 (continuity)', () => {
  approx(throatReynolds(0.05, 0.0127), 0.05 * 0.0127 / 1e-6, 1e-6);
});

test('calibration round-trip', () => {
  approx(mdotFromHz(hzFromMdot(7e-3)), 7e-3, 1e-9);
  // anchors from FlowRatevsFrequency.png: ~2.3 g/s @ 6 Hz, ~11.5 g/s @ 42 Hz
  approx(mdotFromHz(6), 2.3e-3, 1e-4);
  approx(mdotFromHz(42), 11.5e-3, 1e-4);
});

test('latticeParams honors Mach cap when viscosity allows', () => {
  const lp = latticeParams({ dxM: 5e-4, uMaxPhys: 0.02 });
  approx(lp.uLat, 0.1, 1e-9, 'uLat');
  ok(lp.tau >= 0.51, 'tau floor');
  approx(NU * lp.dt / (5e-4 * 5e-4), (lp.tau - 0.5) / 3, 1e-12, 'nu consistency');
});

test('latticeParams enforces tau floor for fast flows', () => {
  const lp = latticeParams({ dxM: 5e-4, uMaxPhys: 0.2 });
  approx(lp.tau, 0.51, 1e-9);
  ok(lp.uLat > 0.1, 'accepts higher lattice velocity');
  ok(lp.warnings.includes('smagorinsky-recommended'));
});

test('unit round-trip: physical <-> lattice velocity', () => {
  const lp = latticeParams({ dxM: 5e-4, uMaxPhys: 0.05 });
  const uPhys = 0.031;
  approx((uPhys * lp.dt / 5e-4) * (5e-4 / lp.dt), uPhys, 1e-12);
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npm test`
Expected: FAIL (cannot find `../js/units.js`).

- [ ] **Step 3: Implement `js/units.js`**

```js
// Physical <-> lattice unit conversions. Water at room temperature.
export const RHO = 1000;      // kg/m^3
export const NU = 1.0e-6;     // m^2/s

// Flow-meter calibration (FlowRatevsFrequency.png): linear fit through
// (6 Hz, 2.3e-3 kg/s) and (42 Hz, 11.5e-3 kg/s).
const CAL_SLOPE = (11.5e-3 - 2.3e-3) / (42 - 6);
const CAL_INTERCEPT = 2.3e-3 - CAL_SLOPE * 6;
export const MDOT_MIN = 2.3e-3, MDOT_MAX = 11.5e-3;

export function hzFromMdot(mdot) { return (mdot - CAL_INTERCEPT) / CAL_SLOPE; }
export function mdotFromHz(hz) { return CAL_SLOPE * hz + CAL_INTERCEPT; }

// mdot [kg/s], d1 and depth [m] -> mean inlet velocity [m/s]
export function inletVelocity(mdot, d1M, depthM) { return mdot / (RHO * d1M * depthM); }

// By continuity U_throat*d4 = U_in*d1, so Re_throat = U_throat*d4/nu = U_in*d1/nu.
export function throatReynolds(uInlet, d1M) { return uInlet * d1M / NU; }

// Pick dt for a given dx [m] and max physical speed [m/s]:
// prefer lattice Mach cap uLat<=0.1; if that would push tau below tauMin,
// enforce tau=tauMin instead and accept a higher lattice velocity.
export function latticeParams({ dxM, uMaxPhys, tauMin = 0.51, uLatCap = 0.1 }) {
  const warnings = [];
  let dt = uLatCap * dxM / uMaxPhys;
  let tau = 3 * (NU * dt / (dxM * dxM)) + 0.5;
  if (tau < tauMin) {
    tau = tauMin;
    dt = ((tauMin - 0.5) / 3) * dxM * dxM / NU;
    warnings.push('smagorinsky-recommended');
  }
  const uLat = uMaxPhys * dt / dxM;
  if (uLat > 0.17) warnings.push('high-mach');
  return { dt, tau, uLat, warnings };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test`
Expected: all `units` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add js/units.js test/units.test.mjs
git commit -m "feat: unit conversions and lattice parameter selection"
```

---

### Task 3: geometry.js — parameters, derived values, constraints

**Files:**
- Create: `js/geometry.js`
- Test: `test/geometry.test.mjs`

- [ ] **Step 1: Write failing tests** — create `test/geometry.test.mjs`:

```js
import { test, ok, approx } from './harness.mjs';
import { DEFAULT_PARAMS, CAPS, derived, violations, maxTheta1, maxD5, clampParams }
  from '../js/geometry.js';

test('baseline parameters satisfy both caps', () => {
  const d = derived(DEFAULT_PARAMS);
  ok(d.totalLen <= CAPS.totalLenMM, `len ${d.totalLen}`);
  ok(d.exitHeight <= CAPS.exitHeightMM, `height ${d.exitHeight}`);
  ok(violations(DEFAULT_PARAMS).length === 0);
});

test('derived values are correct', () => {
  const p = { ...DEFAULT_PARAMS, d4: 20, d5: 100, theta1: 30 };
  const d = derived(p);
  approx(d.exitHeight, 20 + 2 * 100 * Math.tan(Math.PI / 6), 1e-9);
  approx(d.totalLen, p.d1 + p.d2 + p.d3 + p.d5 + p.d6, 1e-9);
});

test('violations flags each cap', () => {
  ok(violations({ ...DEFAULT_PARAMS, d5: 300 }).includes('length'));
  ok(violations({ ...DEFAULT_PARAMS, theta1: 40 }).includes('height'));
});

test('maxTheta1/maxD5 sit exactly on the caps', () => {
  const p = { ...DEFAULT_PARAMS };
  const t1 = maxTheta1(p);
  ok(violations({ ...p, theta1: t1 - 0.01 }).length === 0);
  ok(violations({ ...p, theta1: t1 + 0.1 }).includes('height'));
  const d5 = maxD5(p);
  ok(violations({ ...p, d5: d5 - 0.01 }).length === 0);
  ok(violations({ ...p, d5: d5 + 1 }).length > 0);
});

test('clampParams repairs random violating draws', () => {
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let k = 0; k < 200; k++) {
    const p = {
      d1: 12.7, d2: 8 + rnd() * 30, d3: 8 + rnd() * 40, d4: 10 + rnd() * 30,
      d5: 60 + rnd() * 200, d6: 10 + rnd() * 50,
      theta1: 5 + rnd() * 35, theta2: rnd() * 40, nVanes: Math.floor(rnd() * 11),
    };
    const q = clampParams(p);
    ok(violations(q).length === 0, `draw ${k} still violates: ${JSON.stringify(q)}`);
    ok(q.d4 === p.d4 && q.d1 === p.d1, 'clamp only touches theta1/d5/d6');
  }
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npm test`
Expected: FAIL (cannot find `../js/geometry.js`).

- [ ] **Step 3: Implement constraint half of `js/geometry.js`**

```js
// Channel geometry: parameters (mm/deg), constraints, and mask rasterization.
export const CAPS = { totalLenMM: 228.6, exitHeightMM: 203.2 }; // 9in, 8in
export const SOLID = 0, FLUID = 1, INLET = 2, OUTLET = 3;

export const DEFAULT_PARAMS = {
  d1: 12.7, d2: 15, d3: 20, d4: 20, d5: 150, d6: 25,
  theta1: 25, theta2: 15, nVanes: 6,
};

const rad = (deg) => deg * Math.PI / 180;
const deg = (r) => r * 180 / Math.PI;

export function derived(p) {
  const exitHeight = p.d4 + 2 * p.d5 * Math.tan(rad(p.theta1));
  const totalLen = p.d1 + p.d2 + p.d3 + p.d5 + p.d6;
  return { exitHeight, totalLen };
}

export function violations(p) {
  const d = derived(p), v = [];
  if (d.totalLen > CAPS.totalLenMM + 1e-9) v.push('length');
  if (d.exitHeight > CAPS.exitHeightMM + 1e-9) v.push('height');
  return v;
}

export function maxTheta1(p) {
  return deg(Math.atan((CAPS.exitHeightMM - p.d4) / (2 * p.d5)));
}

export function maxD5(p) {
  const fromLen = CAPS.totalLenMM - (p.d1 + p.d2 + p.d3 + p.d6);
  const fromH = (CAPS.exitHeightMM - p.d4) / (2 * Math.tan(rad(Math.max(p.theta1, 0.5))));
  return Math.min(fromLen, fromH);
}

// Repair a violating parameter set by shrinking theta1, then d5, then d6.
export function clampParams(p) {
  const q = { ...p };
  if (derived(q).exitHeight > CAPS.exitHeightMM)
    q.theta1 = Math.min(q.theta1, maxTheta1(q) - 1e-6);
  if (derived(q).totalLen > CAPS.totalLenMM) {
    const excess = derived(q).totalLen - CAPS.totalLenMM;
    q.d5 = Math.max(20, q.d5 - excess);
  }
  if (derived(q).totalLen > CAPS.totalLenMM)
    q.d6 = Math.max(5, q.d6 - (derived(q).totalLen - CAPS.totalLenMM));
  return q;
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test`
Expected: all `geometry` constraint tests PASS.
Note: `clampParams` shrinking d5 can still violate if d6 huge — final d6 clamp handles it; if any random draw still fails, tighten the loop by repeating the theta1/d5/d6 sequence twice.

- [ ] **Step 5: Commit**

```bash
git add js/geometry.js test/geometry.test.mjs
git commit -m "feat: geometry parameters, derived values, constraint clamping"
```

---

### Task 4: geometry.js — buildMask rasterization + connectivity

**Files:**
- Modify: `js/geometry.js` (append)
- Test: `test/geometry.test.mjs` (append)

Geometry model (all mm; y down; `yc` = channel centerline):
- Domain height `H = max(exitHeight + 2*margin*dx, 2*(d4/2 + d2 + 10))` so the duct+turn always fit; `yc = H/2`.
- Inlet duct: `0 ≤ x ≤ d1`, `0 ≤ y ≤ Cy` where `Cy = yc − d4/2 − d2` (duct length adapts to domain).
- Turn/contraction: quarter-annulus around center `C = (d1+d2, Cy)`; inner radius `d2` (fillet), outer radius blends smoothly from `d1+d2` (duct side) to `d2+d4` (throat side) with angle — this contracts width d1 → d4 around the 90° bend.
- Throat: `d1+d2 ≤ x ≤ d1+d2+d3`, `|y−yc| ≤ d4/2`.
- Diffuser: next `d5` of x, `|y−yc| ≤ d4/2 + (x−xd)·tanθ1`.
- Exit section: next `d6` of x, `|y−yc| ≤ exitHeight/2`.
- Vanes: `nVanes` flat plates at the vane plane (start of exit section), chord `Lv = min(0.8·d6, 15)`, thickness `max(1mm, 2.2·dx)`, centers evenly spaced at `yc + exitHeight·(j/(N+1) − 1/2)`, direction `(cosθ2, sign(offset)·sinθ2)` (mirrored about centerline; a centered vane is axial).

- [ ] **Step 1: Write failing tests** — append to `test/geometry.test.mjs`:

```js
import { buildMask } from '../js/geometry.js';
// (merge with the existing import from '../js/geometry.js')

test('buildMask baseline: fluid regions, inlet, outlet all present', () => {
  const g = buildMask(DEFAULT_PARAMS, 1.0);
  ok(g.ok, g.error);
  const { mask, nx, ny } = g;
  let nInlet = 0, nOutlet = 0, nFluid = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 2) nInlet++;
    if (mask[i] === 3) nOutlet++;
    if (mask[i] !== 0) nFluid++;
  }
  approx(nInlet, Math.round(12.7 / 1.0), 2, 'inlet width in cells');
  ok(nOutlet > 100, `outlet cells ${nOutlet}`); // exit height ~160mm at 1mm/cell
  ok(nFluid > 0.2 * nx * ny, 'substantial fluid fraction');
});

test('buildMask connectivity: inlet reaches outlet', () => {
  ok(buildMask(DEFAULT_PARAMS, 1.0).meta.connected);
});

test('vanes add solid cells and never block the channel', () => {
  const g0 = buildMask({ ...DEFAULT_PARAMS, nVanes: 0 }, 1.0);
  const g6 = buildMask({ ...DEFAULT_PARAMS, nVanes: 6 }, 1.0);
  let f0 = 0, f6 = 0;
  for (let i = 0; i < g0.mask.length; i++) { if (g0.mask[i] !== 0) f0++; if (g6.mask[i] !== 0) f6++; }
  ok(f6 < f0, 'vanes removed fluid cells');
  ok(g6.meta.connected, 'still connected with vanes');
});

test('buildMask edge cases stay connected', () => {
  for (const p of [
    { ...DEFAULT_PARAMS, theta1: 5, d5: 60 },          // shallow short diffuser
    { ...DEFAULT_PARAMS, theta1: maxTheta1(DEFAULT_PARAMS) - 0.1 }, // widest
    { ...DEFAULT_PARAMS, d4: 35, nVanes: 10, theta2: 35 },
  ]) {
    const g = buildMask(clampParams(p), 1.0);
    ok(g.ok && g.meta.connected, JSON.stringify(p));
  }
});

test('buildMask rejects violating params', () => {
  ok(!buildMask({ ...DEFAULT_PARAMS, d5: 400 }, 1.0).ok);
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npm test`
Expected: FAIL (`buildMask` not exported).

- [ ] **Step 3: Implement — append to `js/geometry.js`**

```js
const smooth = (t) => t * t * (3 - 2 * t); // smoothstep

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-12;
  let t = ((px - ax) * dx + (py - ay) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Rasterize params to a mask grid. dxMM = cell size in mm.
// Returns {ok, error?, mask, nx, ny, dx, yc, margin, meta:{connected, exitHeight, totalLen}}
export function buildMask(p, dxMM, margin = 2) {
  const bad = violations(p);
  if (bad.length) return { ok: false, error: `constraint violated: ${bad.join(', ')}` };
  const der = derived(p);
  const H = Math.max(der.exitHeight + 2 * margin * dxMM, 2 * (p.d4 / 2 + p.d2 + 10));
  const nx = Math.ceil(der.totalLen / dxMM) + margin;
  const ny = Math.ceil(H / dxMM);
  const yc = (ny * dxMM) / 2;
  const Cy = yc - p.d4 / 2 - p.d2;      // duct bottom / turn center y
  if (Cy < 2 * dxMM) return { ok: false, error: 'duct does not fit (increase exit height or reduce d2/d4)' };
  const Cx = p.d1 + p.d2;
  const xt = p.d1 + p.d2, xd = xt + p.d3, xe = xd + p.d5, xEnd = xe + p.d6;
  const t1 = Math.tan(p.theta1 * Math.PI / 180);
  const th2 = p.theta2 * Math.PI / 180;
  const N = p.nVanes | 0;
  const Lv = Math.min(0.8 * p.d6, 15), halfC = Lv / 2;
  const vaneTh = Math.max(1.0, 2.2 * dxMM) / 2;
  const xv = xe + halfC + dxMM;         // vane center plane
  const vanes = [];
  for (let j = 1; j <= N; j++) {
    const o = der.exitHeight * (j / (N + 1) - 0.5);
    const dirY = Math.sign(o) * Math.sin(th2), dirX = Math.cos(th2);
    vanes.push([xv - halfC * dirX, yc + o - halfC * dirY, xv + halfC * dirX, yc + o + halfC * dirY]);
  }

  const isFluid = (x, y) => {
    if (x >= 0 && x <= p.d1 && y >= 0 && y <= Cy) return true;                    // duct
    if (x <= Cx && y >= Cy) {                                                     // turn
      const r = Math.hypot(x - Cx, y - Cy);
      const a = Math.atan2(y - Cy, Cx - x) / (Math.PI / 2);                       // 0=duct side, 1=throat side
      if (a >= 0 && a <= 1) {
        const ro = (p.d1 + p.d2) + smooth(a) * ((p.d2 + p.d4) - (p.d1 + p.d2));
        if (r >= p.d2 && r <= ro) return true;
      }
    }
    const dy = Math.abs(y - yc);
    if (x >= xt && x <= xd && dy <= p.d4 / 2) return true;                        // throat
    if (x >= xd && x <= xe && dy <= p.d4 / 2 + (x - xd) * t1) return true;        // diffuser
    if (x >= xe && x <= xEnd && dy <= der.exitHeight / 2) return true;            // exit
    return false;
  };

  const mask = new Uint8Array(nx * ny); // SOLID
  for (let gy = 0; gy < ny; gy++) {
    const ymm = (gy + 0.5) * dxMM;
    for (let gx = 0; gx < nx; gx++) {
      const xmm = (gx + 0.5) * dxMM - margin * dxMM;
      if (!isFluid(xmm, ymm)) continue;
      let solid = false;
      for (const [ax, ay, bx, by] of vanes)
        if (distToSeg(xmm, ymm, ax, ay, bx, by) <= vaneTh) { solid = true; break; }
      mask[gy * nx + gx] = solid ? SOLID : FLUID;
    }
  }
  // inlet: top row fluid cells (duct opening); outlet: rightmost fluid column
  for (let gx = 0; gx < nx; gx++) if (mask[gx] === FLUID) mask[gx] = INLET;
  for (let gy = 0; gy < ny; gy++) {
    const i = gy * nx + (nx - 1);
    if (mask[i] === FLUID) mask[i] = OUTLET;
  }
  // BFS connectivity from inlet to outlet
  const seen = new Uint8Array(nx * ny), q = [];
  for (let gx = 0; gx < nx; gx++) if (mask[gx] === INLET) { q.push(gx); seen[gx] = 1; }
  let connected = false;
  while (q.length) {
    const i = q.pop(), gx = i % nx, gy = (i / nx) | 0;
    if (mask[i] === OUTLET) { connected = true; break; }
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const tx = gx + ox, ty = gy + oy;
      if (tx < 0 || tx >= nx || ty < 0 || ty >= ny) continue;
      const j = ty * nx + tx;
      if (!seen[j] && mask[j] !== SOLID) { seen[j] = 1; q.push(j); }
    }
  }
  return { ok: true, mask, nx, ny, dx: dxMM, yc, margin,
           meta: { connected, exitHeight: der.exitHeight, totalLen: der.totalLen } };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test`
Expected: all geometry tests PASS. If the inlet-width count is off by more than ±2 cells, check the `margin` x-offset in the cell-center formula.

- [ ] **Step 5: Commit**

```bash
git add js/geometry.js test/geometry.test.mjs
git commit -m "feat: geometry mask rasterization with vanes and connectivity check"
```

---

### Task 5: lbm.js — D2Q9 TRT core (collide, stream, bounce-back)

**Files:**
- Create: `js/lbm.js`
- Test: `test/lbm.test.mjs`

- [ ] **Step 1: Write failing tests** — create `test/lbm.test.mjs`:

```js
import { test, ok, approx } from './harness.mjs';
import { LBM, feq, W, CX, CY, OPP } from '../js/lbm.js';
import { FLUID, SOLID } from '../js/geometry.js';

test('feq sums to rho and momentum', () => {
  let r = 0, mx = 0, my = 0;
  for (let i = 0; i < 9; i++) {
    const f = feq(i, 1.2, 0.05, -0.03);
    r += f; mx += f * CX[i]; my += f * CY[i];
  }
  approx(r, 1.2, 1e-12); approx(mx, 1.2 * 0.05, 1e-12); approx(my, 1.2 * -0.03, 1e-12);
});

test('Taylor-Green vortex decays at the analytic viscous rate', () => {
  const n = 64, tau = 0.8, nu = (tau - 0.5) / 3, u0 = 0.04, k = 2 * Math.PI / n;
  const mask = new Uint8Array(n * n).fill(FLUID);
  const sim = new LBM({ nx: n, ny: n, mask, tau, uIn: 0, periodic: true });
  sim.initEquilibrium(() => 1, (x, y) => [-u0 * Math.cos(k * x) * Math.sin(k * y),
                                           u0 * Math.sin(k * x) * Math.cos(k * y)]);
  const steps = 400;
  sim.step(steps);
  const { ux } = sim.macros();
  let amp = 0;
  for (const v of ux) amp = Math.max(amp, Math.abs(v));
  const expected = u0 * Math.exp(-nu * 2 * k * k * steps);
  approx(amp, expected, 0.02 * expected, 'TG decay amplitude');
});

test('wall-bounded shear mode decays at the analytic rate (bounce-back)', () => {
  const nx = 8, ny = 34, H = ny - 2, tau = 0.9, nu = (tau - 0.5) / 3, u0 = 0.03;
  const mask = new Uint8Array(nx * ny).fill(FLUID);
  for (let x = 0; x < nx; x++) { mask[x] = SOLID; mask[(ny - 1) * nx + x] = SOLID; }
  const sim = new LBM({ nx, ny, mask, tau, uIn: 0, periodic: true });
  // ux = u0 sin(pi*(y-0.5)/H): zero at half-way wall planes y=0.5 and y=ny-1.5
  sim.initEquilibrium(() => 1, (x, y) => [u0 * Math.sin(Math.PI * (y - 0.5) / H), 0]);
  const steps = 600;
  sim.step(steps);
  const { ux } = sim.macros();
  let amp = 0;
  for (const v of ux) amp = Math.max(amp, Math.abs(v));
  const expected = u0 * Math.exp(-nu * (Math.PI / H) ** 2 * steps);
  approx(amp, expected, 0.03 * expected, 'channel mode decay');
});
```

Note: `periodic: true` wraps streaming at all domain edges; the wall test is periodic in x with solid rows in y.

- [ ] **Step 2: Run tests, verify failure**

Run: `npm test`
Expected: FAIL (cannot find `../js/lbm.js`).

- [ ] **Step 3: Implement `js/lbm.js` core**

```js
// D2Q9 TRT lattice Boltzmann solver. Grid: x = column, y = row (top-down).
import { SOLID, FLUID, INLET, OUTLET } from './geometry.js';

export const W = [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36];
export const CX = [0, 1, 0, -1, 0, 1, -1, -1, 1];
export const CY = [0, 0, 1, 0, -1, 1, 1, -1, -1];
export const OPP = [0, 3, 4, 1, 2, 7, 8, 5, 6];

export function feq(i, rho, ux, uy) {
  const cu = CX[i] * ux + CY[i] * uy, u2 = ux * ux + uy * uy;
  return W[i] * rho * (1 + 3 * cu + 4.5 * cu * cu - 1.5 * u2);
}

export class LBM {
  // {nx, ny, mask, tau, uIn (lattice, +y at inlet), magic=0.25, smagorinsky=0, periodic=false}
  constructor({ nx, ny, mask, tau, uIn, magic = 0.25, smagorinsky = 0, periodic = false }) {
    this.nx = nx; this.ny = ny; this.mask = mask;
    this.tau = tau; this.uIn = uIn; this.smag = smagorinsky; this.periodic = periodic;
    this.omP = 1 / tau;
    this.omM = 1 / (0.5 + magic / (tau - 0.5));
    this.f = new Float64Array(nx * ny * 9);
    this.g = new Float64Array(nx * ny * 9);
    this.steps = 0;
    this.inletCells = []; this.outletCells = [];
    for (let i = 0; i < nx * ny; i++) {
      if (mask[i] === INLET) this.inletCells.push(i);
      if (mask[i] === OUTLET) this.outletCells.push(i);
    }
    this.initEquilibrium();
  }

  initEquilibrium(rhoFn, uFn) {
    const { nx, ny, f } = this;
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const c = (y * nx + x) * 9;
      const rho = rhoFn ? rhoFn(x, y) : 1;
      const [ux, uy] = uFn ? uFn(x, y) : [0, 0];
      for (let i = 0; i < 9; i++) f[c + i] = feq(i, rho, ux, uy);
    }
    this.g.set(this.f);
  }

  step(n = 1) { for (let s = 0; s < n; s++) this._step(); return this.steps; }

  _step() {
    const { nx, ny, mask, f, g, omP, omM, periodic, smag, tau } = this;
    const fe = new Float64Array(9);
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const c = y * nx + x;
      if (mask[c] === SOLID) continue;
      const b = c * 9;
      let rho = 0, mx = 0, my = 0;
      for (let i = 0; i < 9; i++) { const fi = f[b + i]; rho += fi; mx += fi * CX[i]; my += fi * CY[i]; }
      const ux = mx / rho, uy = my / rho;
      for (let i = 0; i < 9; i++) fe[i] = feq(i, rho, ux, uy);
      let oP = omP, oM = omM;
      if (smag > 0) { // Smagorinsky: raise effective tau from non-equilibrium stress
        let pxx = 0, pyy = 0, pxy = 0;
        for (let i = 0; i < 9; i++) {
          const fn = f[b + i] - fe[i];
          pxx += fn * CX[i] * CX[i]; pyy += fn * CY[i] * CY[i]; pxy += fn * CX[i] * CY[i];
        }
        const Q = Math.sqrt(pxx * pxx + pyy * pyy + 2 * pxy * pxy);
        const tEff = 0.5 * (tau + Math.sqrt(tau * tau + 18 * Math.SQRT2 * smag * smag * Q / rho));
        oP = 1 / tEff; oM = 1 / (0.5 + 0.25 / (tEff - 0.5));
      }
      for (let i = 0; i < 9; i++) {
        const j = OPP[i];
        const fp = 0.5 * (f[b + i] + f[b + j]) - 0.5 * (fe[i] + fe[j]);
        const fm = 0.5 * (f[b + i] - f[b + j]) - 0.5 * (fe[i] - fe[j]);
        const post = f[b + i] - oP * fp - oM * fm;
        let tx = x + CX[i], ty = y + CY[i];
        if (periodic) { tx = (tx + nx) % nx; ty = (ty + ny) % ny; }
        if (tx < 0 || tx >= nx || ty < 0 || ty >= ny || mask[ty * nx + tx] === SOLID)
          g[b + j] = post;                       // half-way bounce-back
        else
          g[(ty * nx + tx) * 9 + i] = post;      // stream
      }
    }
    this._applyInlet(g);
    this._applyOutlet(g);
    this.f = g; this.g = f;                      // ping-pong (old f becomes scratch)
    this.steps++;
  }

  _applyInlet(g) {
    const v = this.uIn;
    for (const c of this.inletCells) {
      const b = c * 9;
      const S = g[b] + g[b + 1] + g[b + 3];
      const K = g[b + 4] + g[b + 7] + g[b + 8];
      const rho = (S + 2 * K) / (1 - v);
      const t = 0.5 * (g[b + 1] - g[b + 3]);
      g[b + 2] = g[b + 4] + (2 / 3) * rho * v;   // Zou-He, flow +y (down)
      g[b + 5] = g[b + 7] + rho * v / 6 - t;
      g[b + 6] = g[b + 8] + rho * v / 6 + t;
    }
  }

  _applyOutlet(g) {
    const { nx } = this;
    for (const c of this.outletCells) {
      const b = c * 9, bn = (c - 1) * 9;         // neighbor one column left
      g[b + 3] = g[bn + 3]; g[b + 6] = g[bn + 6]; g[b + 7] = g[bn + 7];
      let rho = 0;
      for (let i = 0; i < 9; i++) rho += g[b + i];
      const s = 1 / rho;                          // renormalize: anchors pressure
      for (let i = 0; i < 9; i++) g[b + i] *= s;
    }
  }

  macros() {
    const { nx, ny, mask, f } = this;
    const rho = new Float32Array(nx * ny), ux = new Float32Array(nx * ny), uy = new Float32Array(nx * ny);
    for (let c = 0; c < nx * ny; c++) {
      if (mask[c] === SOLID) continue;
      const b = c * 9;
      let r = 0, mx = 0, my = 0;
      for (let i = 0; i < 9; i++) { const fi = f[b + i]; r += fi; mx += fi * CX[i]; my += fi * CY[i]; }
      rho[c] = r; ux[c] = mx / r; uy[c] = my / r;
    }
    return { rho, ux, uy };
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test`
Expected: `feq`, Taylor–Green, and wall-mode tests PASS. TG within 2%, wall mode within 3%.
If TG fails: check TRT sign conventions (post = f − ω⁺(f⁺−fe⁺) − ω⁻(f⁻−fe⁻)). If the wall test fails but TG passes: bug is in the bounce-back branch.

- [ ] **Step 5: Commit**

```bash
git add js/lbm.js test/lbm.test.mjs
git commit -m "feat: D2Q9 TRT solver with bounce-back, Zou-He inlet, outflow"
```

---

### Task 6: lbm.js — diagnostics + full-geometry integration test

**Files:**
- Modify: `js/lbm.js` (append methods + function)
- Test: `test/lbm.test.mjs` (append)

- [ ] **Step 1: Write failing tests** — append to `test/lbm.test.mjs`:

```js
import { uniformity } from '../js/lbm.js';
import { buildMask, DEFAULT_PARAMS } from '../js/geometry.js';
import { inletVelocity, latticeParams } from '../js/units.js';

test('uniformity: 1 for plug flow, lower for peaked flow, 0-guarded', () => {
  approx(uniformity(new Float32Array([2, 2, 2, 2])), 1, 1e-9);
  const peaked = uniformity(new Float32Array([0.5, 2, 4, 2, 0.5]));
  ok(peaked > 0 && peaked < 0.8, `peaked=${peaked}`);
  approx(uniformity(new Float32Array([0, 0])), 0, 1e-9);
});

test('integration: baseline geometry runs stable and conserves mass', async () => {
  const dxMM = 1.5, depthM = 0.0127, mdot = 6e-3;
  const geo = buildMask(DEFAULT_PARAMS, dxMM);
  ok(geo.ok && geo.meta.connected);
  const uPhys = inletVelocity(mdot, DEFAULT_PARAMS.d1 / 1000, depthM);
  const uMax = uPhys * Math.max(1, DEFAULT_PARAMS.d1 / DEFAULT_PARAMS.d4);
  const lp = latticeParams({ dxM: dxMM / 1000, uMaxPhys: uMax });
  const sim = new LBM({ nx: geo.nx, ny: geo.ny, mask: geo.mask,
                        tau: lp.tau, uIn: uPhys * lp.dt / (dxMM / 1000) });
  sim.step(6000);
  ok(sim.isStable(), 'no NaN / runaway velocity');
  const fluxes = sim.fluxes();
  ok(Math.abs(fluxes.out - fluxes.in) / fluxes.in < 0.03,
     `mass imbalance in=${fluxes.in} out=${fluxes.out}`);
  const prof = sim.exitProfile();
  const u = uniformity(prof.u);
  ok(u > 0.1 && u <= 1, `uniformity ${u}`);
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npm test`
Expected: FAIL (`uniformity`, `isStable`, `fluxes`, `exitProfile` missing).

- [ ] **Step 3: Implement — append inside `class LBM` and at module level in `js/lbm.js`**

```js
  // --- append inside class LBM ---
  isStable() {
    const { nx, ny, mask, f } = this;
    for (let c = 0; c < nx * ny; c += 17) {          // sampled scan
      if (mask[c] === SOLID) continue;
      const b = c * 9;
      let r = 0, mx = 0, my = 0;
      for (let i = 0; i < 9; i++) { const fi = f[b + i]; r += fi; mx += fi * CX[i]; my += fi * CY[i]; }
      if (!Number.isFinite(r) || r <= 0) return false;
      if ((mx * mx + my * my) / (r * r) > 0.4 * 0.4) return false;
    }
    return true;
  }

  // inlet flux (sum uy over duct row 1) and outlet flux (sum ux at column nx-2)
  fluxes() {
    const { nx, ny, mask, f } = this;
    let fin = 0, fout = 0;
    for (let x = 0; x < nx; x++) {
      const c = nx + x;                               // row y=1
      if (mask[c] === SOLID || mask[x] !== INLET) continue;
      const b = c * 9;
      let r = 0, my = 0;
      for (let i = 0; i < 9; i++) { r += f[b + i]; my += f[b + i] * CY[i]; }
      fin += my / r;
    }
    for (let y = 0; y < ny; y++) {
      const c = y * nx + (nx - 2);
      if (mask[c] === SOLID || mask[y * nx + nx - 1] !== OUTLET) continue;
      const b = c * 9;
      let r = 0, mx = 0;
      for (let i = 0; i < 9; i++) { r += f[b + i]; mx += f[b + i] * CX[i]; }
      fout += mx / r;
    }
    return { in: fin, out: fout };
  }

  // streamwise velocity sampled one column before the outlet, fluid cells only
  exitProfile() {
    const { nx, ny, mask, f } = this;
    const ys = [], us = [];
    for (let y = 0; y < ny; y++) {
      const c = y * nx + (nx - 2);
      if (mask[c] === SOLID || mask[y * nx + nx - 1] !== OUTLET) continue;
      const b = c * 9;
      let r = 0, mx = 0;
      for (let i = 0; i < 9; i++) { r += f[b + i]; mx += f[b + i] * CX[i]; }
      ys.push(y); us.push(mx / r);
    }
    return { y: Int32Array.from(ys), u: Float32Array.from(us) };
  }

// --- append at module level ---
export function uniformity(profile) {
  const n = profile.length;
  if (!n) return 0;
  let mean = 0;
  for (const v of profile) mean += v;
  mean /= n;
  if (mean <= 1e-12) return 0;
  let varSum = 0;
  for (const v of profile) varSum += (v - mean) * (v - mean);
  const score = 1 - Math.sqrt(varSum / n) / mean;
  return Math.max(0, Math.min(1, score));
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test`
Expected: all PASS. The integration test takes ~10–60 s in Node — that is normal. If mass imbalance > 3%, run 10000 steps instead (flow may not be settled); if still failing, inspect the outlet renormalization.

- [ ] **Step 5: Commit**

```bash
git add js/lbm.js test/lbm.test.mjs
git commit -m "feat: solver diagnostics (stability, fluxes, exit profile, uniformity)"
```

---

### Task 7: optimizer.js — bounded async Nelder–Mead

**Files:**
- Create: `js/optimizer.js`
- Test: `test/optimizer.test.mjs`

- [ ] **Step 1: Write failing tests** — create `test/optimizer.test.mjs`:

```js
import { test, ok, approx } from './harness.mjs';
import { nelderMead } from '../js/optimizer.js';

test('nelderMead finds quadratic minimum within bounds', async () => {
  const r = await nelderMead(
    async (x) => (x[0] - 3) ** 2 + (x[1] + 1) ** 2,
    [0, 0], { bounds: [[-5, 5], [-5, 5]], maxEval: 200, tol: 1e-8 });
  approx(r.x[0], 3, 1e-3); approx(r.x[1], -1, 1e-3);
  ok(r.evals <= 200);
});

test('nelderMead respects bounds (constrained optimum on the edge)', async () => {
  const r = await nelderMead(async (x) => (x[0] - 10) ** 2, [0],
    { bounds: [[-2, 2]], maxEval: 100, tol: 1e-10 });
  approx(r.x[0], 2, 1e-3);
});

test('nelderMead reports progress and honors cancel', async () => {
  let calls = 0, cancelled = false;
  const r = await nelderMead(async (x) => x[0] * x[0], [4], {
    bounds: [[-5, 5]], maxEval: 500,
    onProgress: () => { calls++; if (calls === 10) cancelled = true; },
    shouldStop: () => cancelled,
  });
  ok(calls >= 10 && r.evals < 500, 'stopped early');
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `npm test`
Expected: FAIL (cannot find `../js/optimizer.js`).

- [ ] **Step 3: Implement `js/optimizer.js`**

```js
// Bounded Nelder-Mead with an async objective.
// fn(x:number[]) -> Promise<number>. Returns {x, fx, evals, history}.
export async function nelderMead(fn, x0, {
  bounds, maxEval = 150, tol = 1e-6, scale = 0.15, onProgress = null, shouldStop = null,
} = {}) {
  const n = x0.length;
  const clamp = (x) => x.map((v, i) =>
    bounds ? Math.min(bounds[i][1], Math.max(bounds[i][0], v)) : v);
  let evals = 0;
  const history = [];
  const evalAt = async (x) => {
    const xc = clamp(x);
    const v = await fn(xc);
    evals++;
    history.push({ x: xc.slice(), fx: v });
    if (onProgress) onProgress({ evals, x: xc.slice(), fx: v });
    return { x: xc, fx: v };
  };
  // initial simplex: x0 plus per-axis nudges (scale of the bound range)
  const pts = [await evalAt(x0)];
  for (let i = 0; i < n; i++) {
    const p = x0.slice();
    const span = bounds ? (bounds[i][1] - bounds[i][0]) : Math.abs(p[i]) + 1;
    p[i] += span * scale;
    pts.push(await evalAt(p));
  }
  const [A, G, R, S] = [1, 2, 0.5, 0.5]; // reflect, expand, contract, shrink
  while (evals < maxEval && !(shouldStop && shouldStop())) {
    pts.sort((a, b) => a.fx - b.fx);
    if (Math.abs(pts[n].fx - pts[0].fx) < tol) break;
    const centroid = new Array(n).fill(0);
    for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) centroid[i] += pts[k].x[i] / n;
    const worst = pts[n];
    const xr = centroid.map((c, i) => c + A * (c - worst.x[i]));
    const r = await evalAt(xr);
    if (r.fx < pts[0].fx) {
      const xe = centroid.map((c, i) => c + G * (c - worst.x[i]));
      const e = await evalAt(xe);
      pts[n] = e.fx < r.fx ? e : r;
    } else if (r.fx < pts[n - 1].fx) {
      pts[n] = r;
    } else {
      const xc = centroid.map((c, i) => c + R * (worst.x[i] - c));
      const c = await evalAt(xc);
      if (c.fx < worst.fx) pts[n] = c;
      else for (let k = 1; k <= n; k++)
        pts[k] = await evalAt(pts[0].x.map((v, i) => v + S * (pts[k].x[i] - v)));
    }
  }
  pts.sort((a, b) => a.fx - b.fx);
  return { x: pts[0].x, fx: pts[0].fx, evals, history };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test`
Expected: all optimizer tests PASS.

- [ ] **Step 5: Commit**

```bash
git add js/optimizer.js test/optimizer.test.mjs
git commit -m "feat: bounded async Nelder-Mead optimizer"
```

---

### Task 8: sim-worker.js — interactive simulation worker

**Files:**
- Create: `js/sim-worker.js`

Protocol (main → worker): `{type:'configure', params, mdot, dxMM, depthMM, smag}` (rebuild + run), `{type:'pause'}`, `{type:'resume'}`.
Protocol (worker → main): `{type:'geometry', nx, ny, dx, mask}` (once per configure, mask transferred as copy), `{type:'frame', speed:Uint8Array, maxSpeed, vec:{stride,ux,uy}, profile:{y,u}, score, stats}` ~15 Hz, `{type:'error', message}`, `{type:'unstable'}`.

- [ ] **Step 1: Create `js/sim-worker.js`**

```js
import { buildMask } from './geometry.js';
import { LBM, uniformity } from './lbm.js';
import { inletVelocity, throatReynolds, latticeParams } from './units.js';

let sim = null, running = false, cfg = null, lp = null, uPhysIn = 0;
let lastPost = 0, stepCount0 = 0, t0 = 0;

onmessage = (e) => {
  const m = e.data;
  if (m.type === 'configure') configure(m);
  else if (m.type === 'pause') running = false;
  else if (m.type === 'resume' && sim) { running = true; loop(); }
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
  const smag = m.smag || (lp.warnings.includes('smagorinsky-recommended') ? 0.1 : 0);
  sim = new LBM({ nx: geo.nx, ny: geo.ny, mask: geo.mask, tau: lp.tau,
                  uIn: uPhysIn * lp.dt / dxM, smagorinsky: smag });
  postMessage({ type: 'geometry', nx: geo.nx, ny: geo.ny, dx: geo.dx,
                mask: geo.mask.slice(), meta: geo.meta });
  stepCount0 = 0; t0 = performance.now();
  running = true;
  loop();
}

function loop() {
  if (!running || !sim) return;
  sim.step(cfg.dxMM >= 1 ? 40 : 15);
  if (sim.steps % 200 < 40 && !sim.isStable()) {
    running = false;
    postMessage({ type: 'unstable' });
    return;
  }
  const now = performance.now();
  if (now - lastPost > 66) { lastPost = now; postFrame(now); }
  setTimeout(loop, 0);
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
  for (let c = 0; c < nx * ny; c++) speed[c] = Math.min(255, (sMag[c] / maxS) * 255);
  const stride = 6, vnx = Math.floor(nx / stride), vny = Math.floor(ny / stride);
  const vux = new Float32Array(vnx * vny), vuy = new Float32Array(vnx * vny);
  for (let j = 0; j < vny; j++) for (let i = 0; i < vnx; i++) {
    const c = (j * stride) * nx + i * stride;
    vux[j * vnx + i] = ux[c]; vuy[j * vnx + i] = uy[c];
  }
  const profile = sim.exitProfile();
  const fluxes = sim.fluxes();
  const massErr = fluxes.in > 1e-9 ? Math.abs(fluxes.out - fluxes.in) / fluxes.in : 0;
  const stepsPerSec = (sim.steps - stepCount0) / ((now - t0) / 1000);
  stepCount0 = sim.steps; t0 = now;
  postMessage({
    type: 'frame', speed, maxSpeed: maxS,
    vec: { stride, nx: vnx, ny: vny, ux: vux, uy: vuy },
    profile: { y: profile.y, u: profile.u },
    score: uniformity(profile.u),
    stats: {
      re: Math.round(throatReynolds(uPhysIn, cfg.params.d1 / 1000)),
      mach: lp.uLat.toFixed(3), tau: lp.tau.toFixed(4),
      stepsPerSec: Math.round(stepsPerSec),
      tPhys: (sim.steps * lp.dt).toFixed(2),
      massErrPct: (massErr * 100).toFixed(1),
      warnings: lp.warnings,
    },
  }, [speed.buffer, vux.buffer, vuy.buffer]);
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check js/sim-worker.js`
Expected: no output (exit 0). (`performance`, `postMessage`, `onmessage` are runtime globals; `--check` only parses.)

- [ ] **Step 3: Commit**

```bash
git add js/sim-worker.js
git commit -m "feat: interactive simulation worker"
```

---

### Task 9: ui-simulate.js — controls, rendering, profile plot

**Files:**
- Create: `js/ui-simulate.js`

- [ ] **Step 1: Create `js/ui-simulate.js`**

```js
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
  document.getElementById('sim-stats').innerHTML =
    `<span>Re ${s.re}</span><span>u_lat ${s.mach}</span><span>τ ${s.tau}</span>` +
    `<span>${s.stepsPerSec} steps/s</span><span>t = ${s.tPhys} s</span>` +
    `<span>mass Δ ${s.massErrPct}%</span>` +
    (s.warnings.length ? `<span style="color:#fb5">${s.warnings.join(', ')}</span>` : '');
}

function drawProfile(m) {
  const c = document.getElementById('profile-canvas'), ctx = c.getContext('2d');
  ctx.fillStyle = '#0c0d10'; ctx.fillRect(0, 0, c.width, c.height);
  const u = m.profile.u;
  if (!u.length) return;
  let mean = 0, umax = 1e-9;
  for (const v of u) { mean += v; umax = Math.max(umax, Math.abs(v)); }
  mean /= u.length;
  const sx = (v) => 10 + (v / (umax * 1.15)) * (c.width - 20);
  const sy = (k) => 8 + (k / (u.length - 1)) * (c.height - 16);
  ctx.strokeStyle = '#5c6'; ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.moveTo(sx(mean), sy(0)); ctx.lineTo(sx(mean), sy(u.length - 1)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = '#6ab0ff'; ctx.beginPath();
  for (let k = 0; k < u.length; k++) k ? ctx.lineTo(sx(u[k]), sy(k)) : ctx.moveTo(sx(u[k]), sy(k));
  ctx.stroke();
  ctx.fillStyle = '#9ab'; ctx.font = '11px system-ui';
  ctx.fillText('exit u(y) — dashed: plug flow', 12, c.height - 6);
}

function drawScore(score) {
  document.getElementById('score-value').textContent = score.toFixed(3);
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
```

- [ ] **Step 2: Syntax check**

Run: `node --check js/ui-simulate.js`
Expected: exit 0.

- [ ] **Step 3: Manual smoke test in the browser**

Run: `python3 -m http.server 8123` (or `npm run serve`), open `http://localhost:8123`.
Expected: geometry renders (gray solid, colored fluid), flow develops from the duct through the throat into the diffuser, exit profile plot updates, uniformity score displayed and sparkline moving, stats row live. Dragging any slider rebuilds the geometry ~150 ms later and the readout shows length/height vs caps. Pause/Resume works. θ₁ slider pushed high: exit-height readout turns red only transiently — `clampParams` pulls it back.

- [ ] **Step 4: Commit**

```bash
git add js/ui-simulate.js
git commit -m "feat: simulate tab UI with live field, profile, and score"
```

---

### Task 10: opt-worker.js — headless objective evaluations

**Files:**
- Create: `js/opt-worker.js`

Protocol (main → worker): `{type:'start', base, free:[{key,lo,hi}], mdots:[...], dxMM, depthMM, maxEval, starts}`, `{type:'cancel'}`. `base` is the current Simulate-tab parameter set; `starts` (default 1) runs that many Nelder–Mead starts — the first from the bound midpoints, the rest from random points in the bounds — sharing one global best.
Protocol (worker → main): `{type:'eval', evals, params, score}`, `{type:'best', params, score}`, `{type:'done', best}`, `{type:'error', message}`.

- [ ] **Step 1: Create `js/opt-worker.js`**

```js
import { buildMask, clampParams } from './geometry.js';
import { LBM, uniformity } from './lbm.js';
import { inletVelocity, latticeParams } from './units.js';
import { nelderMead } from './optimizer.js';

let cancelled = false;

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
    let total = 0;
    for (const mdot of mdots) {
      const s = await evalOnce(p, mdot, dxMM, depthMM);
      if (s < 0) return 10;                       // unstable/invalid: big penalty
      total += s;
    }
    const score = total / mdots.length;
    if (score > best.score) { best = { score, params: p }; postMessage({ type: 'best', params: p, score }); }
    return 1 - score;
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
          onProgress: (pr) => postMessage({ type: 'eval', evals: evalsTotal + pr.evals, x: pr.x, score: 1 - pr.fx }),
          shouldStop: () => cancelled });
      evalsTotal += r.evals;
    }
    postMessage({ type: 'done', best, evals: evalsTotal });
  } catch (err) {
    postMessage({ type: 'error', message: String(err) });
  }
};

// Run one configuration to steady state; return uniformity score, or -1 on failure.
async function evalOnce(p, mdot, dxMM, depthMM) {
  const geo = buildMask(p, dxMM);
  if (!geo.ok || !geo.meta.connected) return -1;
  const dxM = dxMM / 1000;
  const uPhys = inletVelocity(mdot, p.d1 / 1000, depthMM / 1000);
  const lp = latticeParams({ dxM, uMaxPhys: uPhys * Math.max(1, p.d1 / p.d4) });
  const sim = new LBM({ nx: geo.nx, ny: geo.ny, mask: geo.mask, tau: lp.tau,
                        uIn: uPhys * lp.dt / dxM,
                        smagorinsky: lp.warnings.includes('smagorinsky-recommended') ? 0.1 : 0 });
  let prev = -1, steadyCount = 0;
  for (let chunk = 0; chunk < 60; chunk++) {       // cap: 60 * 400 = 24000 steps
    sim.step(400);
    if (!sim.isStable()) return -1;
    const u = uniformity(sim.exitProfile().u);
    if (Math.abs(u - prev) < 2e-3) { if (++steadyCount >= 3) return u; }
    else steadyCount = 0;
    prev = u;
    if (cancelled) return prev;
    await new Promise(r => setTimeout(r, 0));      // let cancel messages arrive
  }
  return prev;
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check js/opt-worker.js`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add js/opt-worker.js
git commit -m "feat: headless optimization worker (steady-state objective + Nelder-Mead)"
```

---

### Task 11: ui-optimize.js — optimizer UI

**Files:**
- Create: `js/ui-optimize.js`

- [ ] **Step 1: Create `js/ui-optimize.js`**

```js
import { buildMask, SOLID } from './geometry.js';

const OPTIMIZABLE = [
  { key: 'd2', lo: 6, hi: 40 }, { key: 'd3', lo: 5, hi: 60 }, { key: 'd4', lo: 8, hi: 40 },
  { key: 'd5', lo: 40, hi: 200 }, { key: 'd6', lo: 8, hi: 60 },
  { key: 'theta1', lo: 3, hi: 40 }, { key: 'theta2', lo: 0, hi: 45 },
  { key: 'nVanes', lo: 0, hi: 10 },
];

let worker = null, running = false, rows = [], bestRow = null, hooks = null;
let convHist = [];

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
  rows = []; convHist = []; bestRow = null; freeKeys = null;
  document.querySelector('#opt-table tbody').innerHTML = '';
  worker?.terminate();
  worker = new Worker('./js/opt-worker.js', { type: 'module' });
  worker.onmessage = onMsg;
  worker.postMessage({ type: 'start', base: hooks.getParams(), free,
                       mdots: selectedFlows(), dxMM: 1.2, depthMM: 12.7,
                       maxEval: +document.getElementById('opt-maxeval').value,
                       starts: +document.getElementById('opt-starts').value });
  running = true; btn.textContent = 'Cancel';
  setStatus('Running…');
}

function onMsg(e) {
  const m = e.data;
  if (m.type === 'eval') {
    convHist.push(Math.max(...convHist, m.score));
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
    setStatus(`Done after ${m.evals} evaluations. Best score ${m.best.score.toFixed(3)}.`);
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
    const idx = m.x && rowKeyIndex(o.key);
    return idx != null && idx >= 0 ? (+m.x[idx]).toFixed(1) : '·';
  });
  tr.innerHTML = `<td>${m.evals}</td>` + vals.map(v => `<td>${v}</td>`).join('') +
    `<td>${m.score.toFixed(3)}</td>`;
  if (bestRow && Math.abs(m.score - bestRow.score) < 1e-9) tr.className = 'best';
  tb.prepend(tr);
  while (tb.children.length > 150) tb.lastChild.remove();
}

let freeKeys = null;
function rowKeyIndex(key) {
  if (!freeKeys) freeKeys = [...document.querySelectorAll('#opt-free input[type=checkbox]')]
    .filter(cb => cb.checked).map(cb => cb.dataset.key);
  return freeKeys.indexOf(key);
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
  freeKeys = null;
  const keys = [...document.querySelectorAll('#opt-free input[type=checkbox]')]
    .filter(cb => cb.checked).map(cb => cb.dataset.key);
  const lines = [['eval', ...keys, 'score'].join(',')];
  for (const r of rows) lines.push([r.evals, ...(r.x || []).map(v => (+v).toFixed(3)), r.score.toFixed(4)].join(','));
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(lines.join('\n'));
  a.download = 'optimization.csv';
  a.click();
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check js/ui-optimize.js`
Expected: exit 0.

- [ ] **Step 3: Manual test in the browser**

Open `http://localhost:8123`, switch to Optimize tab.
Expected: parameter checkboxes with bounds (θ₁, θ₂, d₅ pre-checked), flow select, eval count. Click Run: evaluation rows stream into the table (newest on top), convergence curve rises, best-geometry thumbnail updates, status shows progress. Cancel works mid-run. When done: "Send best to Simulate" switches tabs with the optimum applied; "Export CSV" downloads the history.

- [ ] **Step 4: Commit**

```bash
git add js/ui-optimize.js
git commit -m "feat: optimize tab UI with convergence plot and CSV export"
```

---

### Task 12: End-to-end verification + launch config

**Files:**
- Create: `.claude/launch.json`

- [ ] **Step 1: Create `.claude/launch.json`** (browser preview for future sessions)

```json
{
  "version": "0.0.1",
  "configurations": [
    { "name": "lbm-sim", "runtimeExecutable": "python3",
      "runtimeArgs": ["-m", "http.server", "8123"], "port": 8123 }
  ]
}
```

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all tests PASS (units, geometry, lbm incl. integration, optimizer).

- [ ] **Step 3: Browser verification checklist** (use the browser preview / webapp-testing approach)

1. Baseline loads, flow develops, uniformity settles to a steady value (typically 0.3–0.8 at baseline).
2. Physics sanity: increasing θ₁ at fixed d₅ lowers uniformity (stronger separation); adding vanes (0 → 6) at wide θ₁ raises it.
3. Flow slider low→high: Re readout scales linearly; high flow may trigger the `smagorinsky-recommended` warning and still run.
4. Resolution medium: field gets crisper; steps/s drops but UI stays responsive.
5. Degenerate geometry (θ₂ = 45°, 10 vanes, tiny d₆): either runs or shows the geometry-error banner — never a frozen page. Check the browser console for errors.
6. Optimize tab: 20-eval run with θ₁, θ₂ free at mid flow improves on the baseline score; Send-to-Simulate reproduces a similar score at coarse resolution.

- [ ] **Step 4: Fix anything found, then commit**

```bash
git add .claude/launch.json
git commit -m "feat: launch config; end-to-end verification pass"
```

---

## Execution notes

- Tasks 2–7 are pure-module TDD and independent of the browser; Tasks 8–12 are wiring + UI verified by syntax check and browser smoke tests.
- The Node integration test (Task 6) is the slowest (~10–60 s); run `npm test` patiently.
- If any numeric tolerance narrowly fails, first check conventions (y-down, +y inlet flow, D2Q9 ordering) before loosening the tolerance — the tolerances are deliberately generous.
