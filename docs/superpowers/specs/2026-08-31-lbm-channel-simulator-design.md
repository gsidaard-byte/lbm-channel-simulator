# Interactive LBM Channel Simulator — Design

**Date:** 2026-08-31
**Status:** Approved pending user review
**Goal:** A browser-based lattice Boltzmann simulator of a 2D water channel (inlet duct → contraction → throat → wide-angle diffuser → guide vanes → exit) with live sliders for 8 geometric parameters and an automatic optimizer that maximizes exit-flow uniformity.

## 1. Background

The rig (see `2D_Channel.png`) takes flow in through a small vertical duct, turns and contracts it into a throat, expands it through a wide-angle diffuser, and passes it through a cascade of guide vanes before a uniform-as-possible discharge at the exit plane. The design variables are:

| Symbol | Meaning | Baseline | Notes |
|--------|---------|----------|-------|
| d₁ | Inlet duct width | 12.7 mm (0.5″) | Fixed by hardware spec |
| d₂ | Contraction/turn length | 15 mm | Smooth polynomial walls, 90° turn |
| d₃ | Throat length | 20 mm | Straight, constant area |
| d₄ | Throat height | 20 mm | Narrowest section |
| d₅ | Diffuser length | 150 mm | |
| d₆ | Exit section depth | 25 mm | Vane plane → exit plane |
| θ₁ | Diffuser half-angle | 25° | Total included angle 2θ₁ |
| θ₂ | Vane pitch angle | 15° | Vanes mirrored about centerline |

**Hard geometric constraints (always enforced by coupled slider bounds):**
- Total length d₂ + d₃ + d₅ + d₆ ≤ 9″ (228.6 mm)
- Exit height d₄ + 2·d₅·tan θ₁ ≤ 8″ (203.2 mm)

**Flow conditions:** water (ρ = 1000 kg/m³, ν = 1.0×10⁻⁶ m²/s), mass flow 2.3–11.5 g/s per the flow-meter calibration (`FlowRatevsFrequency.png`, ~6–42 Hz). Out-of-plane depth assumed 12.7 mm (editable setting) to convert kg/s → 2D inlet velocity. Resulting throat Reynolds number ≈ 100–900.

**Number of vanes N:** stepper 0–10 (0 = no vanes), default 6. N is a 9th discrete control alongside the 8 continuous parameters.

## 2. Physics core

- **Lattice:** D2Q9.
- **Collision:** TRT (two-relaxation-time), magic parameter Λ = 1/4. Stable at low viscosity; removes viscosity-dependent bounce-back wall error. Optional Smagorinsky eddy viscosity (off by default) for high-flow stability.
- **Walls:** half-way bounce-back for all solid nodes (channel walls and vanes; vanes rasterized ≥ 2 cells thick so they are watertight).
- **Inlet:** Zou–He velocity BC at the top of the inlet duct; uniform profile with magnitude from the mass-flow setting.
- **Outlet:** constant-pressure anti-bounce-back at the exit plane.
- **Units:** app auto-picks Δt so lattice velocity ≤ 0.1 (Mach safety) given Δx; reports τ, lattice u, and warns if τ < 0.505.
- **Grid:** Δx = 0.5 mm default (~460×420 cells at baseline); resolution selector coarse (1 mm) / medium (0.5 mm) / fine (0.35 mm).

### Geometry construction

`buildMask(params, dx) → {mask: Uint8Array, meta}` rasterizes, in order: vertical inlet duct (width d₁), quarter-turn contraction over d₂ (smooth cubic wall curves from the diagram's profile), straight throat (d₃ × d₄), symmetric diffuser (d₅, ±θ₁ walls), vane cascade at the vane plane (N thin plates at ±θ₂, mirrored about the centerline, evenly spaced across the local channel height), exit section (d₆ deep), outflow column. Pure function; no solver state.

### Diagnostics

- **Exit profile:** u(y) sampled one cell upstream of the outlet.
- **Uniformity score:** `1 − std(u)/mean(u)` over the exit plane (1.0 = plug flow). Displayed live with a convergence sparkline.
- **Mass check:** inlet vs outlet flux, displayed live.

## 3. Simulate tab

**Left panel (controls):**
- 8 sliders + numeric inputs (d₁–d₆ mm, θ₁, θ₂ deg) with constraint-coupled bounds; readout of total length and exit height vs caps.
- Mass-flow slider 2.3–11.5 g/s with equivalent flow-meter Hz.
- Vane count stepper (0–10).
- Run/pause, reset, resolution selector.
- Live stats: throat Re, lattice Mach, steps/s, simulated physical time.

**Right panel (visualization):**
- Main canvas: velocity magnitude color map (vorticity toggle), solid geometry overlay, optional streamlines.
- Exit-profile plot with plug-flow reference line; uniformity score displayed prominently with time-history sparkline.

**Interaction:** solver runs continuously in a Web Worker posting snapshots ~20 Hz. Slider changes are debounced ~150 ms, rebuild the mask, and restart from a smooth initial state, continuing automatically.

## 4. Optimize tab

- Per-parameter free/frozen checkboxes (frozen = value from Simulate tab); editable bounds pre-clamped by the geometric constraints. Vane count N optimizable as an integer via rounding inside the objective.
- Mass flow is a condition, not a variable: pick a single flow rate or "average over 3 flow rates" (low/mid/high of the calibration range).
- **Optimizer:** Nelder–Mead with bound clamping; optional multi-start (3–5 random simplexes).
- **Objective evaluation:** headless LBM in a dedicated worker at coarse resolution, run until the uniformity score is steady (change < tolerance over a sliding window, with a hard step cap); cost = 1 − uniformity (averaged over flow rates if selected).
- **UI:** evaluation table (params + score), best-so-far highlight, convergence plot, thumbnail of current best geometry, cancel button, CSV export, "Send best to Simulate tab".

## 5. Architecture

```
index.html          — shell, tabs, layout
css/style.css
js/lbm.js           — pure solver: D2Q9 TRT, BCs, step()
js/geometry.js      — buildMask(params), constraint logic (pure)
js/units.js         — physical↔lattice conversions (pure)
js/sim-worker.js    — interactive simulation loop
js/opt-worker.js    — headless evaluation + Nelder–Mead
js/ui-simulate.js   — controls, canvas rendering, plots
js/ui-optimize.js   — optimizer UI
test/run-tests.mjs  — Node test script for the pure modules
```

No build tooling; ES modules loaded directly. Workers import `lbm.js`/`geometry.js`/`units.js` so simulation and optimization share one solver implementation.

## 6. Error handling

- Instability detector in the worker (NaN or lattice u > 0.4): auto-pause, banner suggesting lower flow, coarser Δt (auto-retuned), or enabling Smagorinsky.
- Degenerate geometry (throat blocked, vanes overlapping walls): `buildMask` validates connectivity from inlet to outlet and reports an error instead of running.
- Optimizer evaluations that go unstable or time out return a large penalty cost rather than crashing the run.

## 7. Testing

`node test/run-tests.mjs` validates the pure modules:
1. **Poiseuille test:** straight-channel LBM velocity profile vs analytic parabola (< 2% L2 error).
2. **Mass conservation:** steady-state inlet vs outlet flux (< 1%).
3. **Constraint enforcement:** randomized parameter draws never produce a mask exceeding the 9″/8″ caps; clamping logic verified.
4. **Unit round-trips:** g/s ↔ lattice velocity ↔ Re conversions self-consistent.
5. **Geometry sanity:** inlet-to-outlet connectivity for baseline and edge-case parameter sets.

Browser-side behavior (sliders, rendering, tabs) is verified interactively.

## 8. Out of scope (for now)

- 3D effects, turbulence-resolved simulation, thermal effects.
- Per-vane individual angles (all vanes share ±θ₂; symmetric about centerline).
- Calibrated quantitative match to experiment beyond Reynolds-number matching.
- Server-side or GPU acceleration (solver core is portable if needed later).
