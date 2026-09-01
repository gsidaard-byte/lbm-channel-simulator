// Generate an OpenFOAM (v2606, k-omega SST RANS) case from the Advanced-tab
// geometry. The mesh is the same rasterized fluid region the LBM uses:
// blockMesh makes a uniform box, a cellSet selects the fluid cells, and
// subsetMesh carves the channel (exposed faces become the 'walls' patch).
//
// Usage:
//   node tools/foam-case.mjs --out <dir> [--mdot 6] [--dx 0.5]   generate case
//   node tools/foam-case.mjs --fix-boundary --out <dir>          after subsetMesh
//   node tools/foam-case.mjs --uniformity <line_U.xy>            score a sample
//
// Full run sequence:
//   node tools/foam-case.mjs --out CASE --mdot 60 --dx 0.5
//   openfoam blockMesh -case CASE
//   node tools/foam-case.mjs --out CASE --mdot 60 --dx 0.5   # rewrite cellSet (blockMesh clears it)
//   openfoam subsetMesh fluid -patch walls -overwrite -case CASE
//   node tools/foam-case.mjs --fix-boundary --out CASE       # retype walls patch
//   mkdir -p CASE/0 && cp CASE/0org/* CASE/0/
//   openfoam simpleFoam -case CASE
//   openfoam postProcess -case CASE -func sample -latestTime
//   node tools/foam-case.mjs --uniformity CASE/postProcessing/sample/<t>/exitLine_U.xy
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADV_DEFAULTS, advClamp, buildMaskAdvanced } from '../js/geometry-adv.js';
import { RHO, NU, inletVelocity } from '../js/units.js';

const args = Object.fromEntries(process.argv.slice(2).join(' ')
  .split('--').filter(Boolean).map(s => s.trim().split(/\s+/)));

if (args.uniformity) {
  // parse a raw sample line file: columns y Ux Uy Uz; score = 1 - std/mean of Ux
  const rows = readFileSync(args.uniformity, 'utf8')
    .split('\n').map(l => l.trim().split(/\s+/).map(Number))
    .filter(r => r.length >= 4 && r.every(Number.isFinite));
  const ux = rows.map(r => r[1]);
  const mean = ux.reduce((s, v) => s + v, 0) / ux.length;
  const sd = Math.sqrt(ux.reduce((s, v) => s + (v - mean) ** 2, 0) / ux.length);
  console.log(JSON.stringify({ points: ux.length, meanUx_ms: +mean.toExponential(4),
    stdOverMean: +(sd / mean).toFixed(4),
    uniformity: +Math.max(0, Math.min(1, 1 - sd / mean)).toFixed(4) }));
  process.exit(0);
}

const out = args.out;
if (!out) { console.error('need --out <dir>'); process.exit(1); }

if ('fix-boundary' in args) {
  // subsetMesh types its new patch 'empty'; it must be a wall
  const bf = join(out, 'constant', 'polyMesh', 'boundary');
  let s = readFileSync(bf, 'utf8');
  s = s.replace(/walls\s*\{\s*type\s+empty;\s*inGroups\s+1\(empty\);/,
                'walls\n    {\n        type            wall;\n        inGroups        1(wall);');
  writeFileSync(bf, s);
  console.log('walls patch retyped to wall');
  process.exit(0);
}
const mdot = (parseFloat(args.mdot) || 6) * 1e-3;      // kg/s
const dxMM = parseFloat(args.dx) || 0.5;               // mm
const depthM = 0.0127;

const p = advClamp({ ...ADV_DEFAULTS, scrMode: 'plate' });
const g = buildMaskAdvanced(p, dxMM);
if (!g.ok || !g.meta.connected) { console.error('geometry failed:', g.error); process.exit(1); }
const { nx, ny, mask, margin } = g;

const Uin = inletVelocity(mdot, 12.7 / 1000, depthM);  // m/s, downward at inlet
const I = 0.05, Lturb = 0.1 * 12.7e-3;                 // 5% intensity, 10% of d1
const k0 = Math.max(1e-8, 1.5 * (I * Uin) ** 2);
const om0 = Math.sqrt(k0) / (0.09 ** 0.25 * Lturb);

const Lx = nx * dxMM, Ly = ny * dxMM, dz = dxMM;       // mm (convertToMeters 1e-3)
const dirs = ['system', 'constant', '0org', join('constant', 'polyMesh', 'sets')];
for (const d of dirs) mkdirSync(join(out, d), { recursive: true });

const hdr = (cls, loc, obj) => `FoamFile
{
    version 2.0; format ascii; class ${cls};${loc ? ` location "${loc}";` : ''} object ${obj};
}
`;

writeFileSync(join(out, 'system', 'blockMeshDict'), hdr('dictionary', 'system', 'blockMeshDict') + `
convertToMeters 0.001;
vertices
(
    (0 0 0) (${Lx} 0 0) (${Lx} ${Ly} 0) (0 ${Ly} 0)
    (0 0 ${dz}) (${Lx} 0 ${dz}) (${Lx} ${Ly} ${dz}) (0 ${Ly} ${dz})
);
blocks ( hex (0 1 2 3 4 5 6 7) (${nx} ${ny} 1) simpleGrading (1 1 1) );
boundary
(
    inlet    { type patch; faces ((3 7 6 2)); }
    outlet   { type patch; faces ((2 6 5 1)); }
    boxWalls { type wall;  faces ((1 5 4 0) (0 4 7 3)); }
    frontAndBack { type empty; faces ((0 3 2 1) (4 5 6 7)); }
);
`);

// fluid cellSet: blockMesh cell label = i + j*nx (k=0); grid row gy maps to j = ny-1-gy
const labels = [];
for (let gy = 0; gy < ny; gy++) for (let gx = 0; gx < nx; gx++)
  if (mask[gy * nx + gx] !== 0) labels.push(gx + (ny - 1 - gy) * nx);
writeFileSync(join(out, 'constant', 'polyMesh', 'sets', 'fluid'),
  hdr('cellSet', 'constant/polyMesh/sets', 'fluid') +
  `\n${labels.length}\n(\n${labels.join('\n')}\n)\n`);

writeFileSync(join(out, 'system', 'controlDict'), hdr('dictionary', 'system', 'controlDict') + `
application simpleFoam;
startFrom latestTime; startTime 0; stopAt endTime; endTime 4000; deltaT 1;
writeControl timeStep; writeInterval 4000; purgeWrite 2;
writeFormat ascii; writePrecision 7; timeFormat general; timePrecision 6;
`);

writeFileSync(join(out, 'system', 'fvSchemes'), hdr('dictionary', 'system', 'fvSchemes') + `
ddtSchemes { default steadyState; }
gradSchemes { default Gauss linear; }
divSchemes
{
    default none;
    div(phi,U) bounded Gauss linearUpwind grad(U);
    div(phi,k) bounded Gauss upwind;
    div(phi,omega) bounded Gauss upwind;
    div((nuEff*dev2(T(grad(U))))) Gauss linear;
}
laplacianSchemes { default Gauss linear corrected; }
interpolationSchemes { default linear; }
snGradSchemes { default corrected; }
wallDist { method meshWave; }
`);

writeFileSync(join(out, 'system', 'fvSolution'), hdr('dictionary', 'system', 'fvSolution') + `
solvers
{
    p { solver GAMG; smoother GaussSeidel; tolerance 1e-7; relTol 0.05; }
    "(U|k|omega)" { solver smoothSolver; smoother symGaussSeidel; tolerance 1e-8; relTol 0.1; }
}
SIMPLE
{
    nNonOrthogonalCorrectors 0;
    consistent no;
    residualControl { p 2e-5; U 2e-6; "(k|omega)" 2e-6; }
}
relaxationFactors
{
    fields { p 0.3; }
    equations { U 0.7; k 0.7; omega 0.7; }
}
`);

writeFileSync(join(out, 'constant', 'transportProperties'), hdr('dictionary', 'constant', 'transportProperties') + `
transportModel Newtonian;
nu ${NU};
`);
writeFileSync(join(out, 'constant', 'turbulenceProperties'), hdr('dictionary', 'constant', 'turbulenceProperties') + `
simulationType RAS;
RAS { RASModel kOmegaSST; turbulence on; printCoeffs off; }
`);

const bc = (obj, dim, internal, inlet, outlet, walls) =>
  hdr('vol' + (obj === 'U' ? 'Vector' : 'Scalar') + 'Field', '0', obj) + `
dimensions ${dim};
internalField ${internal};
boundaryField
{
    inlet { ${inlet} }
    outlet { ${outlet} }
    boxWalls { ${walls} }
    walls { ${walls} }
    frontAndBack { type empty; }
}
`;
writeFileSync(join(out, '0org', 'U'),
  bc('U', '[0 1 -1 0 0 0 0]', 'uniform (0 0 0)',
     `type fixedValue; value uniform (0 ${-Uin} 0);`,
     'type inletOutlet; inletValue uniform (0 0 0); value uniform (0 0 0);',
     'type noSlip;'));
writeFileSync(join(out, '0org', 'p'),
  bc('p', '[0 2 -2 0 0 0 0]', 'uniform 0',
     'type zeroGradient;',
     'type fixedValue; value uniform 0;',
     'type zeroGradient;'));
writeFileSync(join(out, '0org', 'k'),
  bc('k', '[0 2 -2 0 0 0 0]', `uniform ${k0}`,
     `type fixedValue; value uniform ${k0};`,
     `type inletOutlet; inletValue uniform ${k0}; value uniform ${k0};`,
     'type kqRWallFunction; value uniform 1e-10;'));
writeFileSync(join(out, '0org', 'omega'),
  bc('omega', '[0 0 -1 0 0 0 0]', `uniform ${om0}`,
     `type fixedValue; value uniform ${om0};`,
     `type inletOutlet; inletValue uniform ${om0}; value uniform ${om0};`,
     `type omegaWallFunction; value uniform ${om0};`));
writeFileSync(join(out, '0org', 'nut'),
  bc('nut', '[0 2 -1 0 0 0 0]', 'uniform 0',
     'type calculated; value uniform 0;',
     'type calculated; value uniform 0;',
     'type nutUSpaldingWallFunction; value uniform 0;'));

// exit-plane sampling line (at the physical exit, upstream of the buffer).
// NOTE: sample coordinates are in mesh units AFTER convertToMeters, i.e. meters.
const xProbe = (g.meta.probeCol + 0.5) * dxMM;
const M = (v) => (v * 1e-3).toExponential(8);
writeFileSync(join(out, 'system', 'sample'), hdr('dictionary', 'system', 'sample') + `
type sets;
libs (sampling);
interpolationScheme cellPoint;
setFormat raw;
fields (U);
sets
(
    exitLine { type uniform; axis y; start (${M(xProbe)} 0 ${M(dz / 2)}); end (${M(xProbe)} ${M(Ly)} ${M(dz / 2)}); nPoints 800; }
);
`);

console.log(JSON.stringify({
  out, nx, ny, fluidCells: labels.length, dxMM,
  mdot_gs: mdot * 1000, Uin_ms: +Uin.toFixed(5),
  Re: Math.round(Uin * 0.0127 / NU), k0: +k0.toExponential(3), omega0: +om0.toFixed(3),
  xProbe_mm: +xProbe.toFixed(2),
}, null, 1));
