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
