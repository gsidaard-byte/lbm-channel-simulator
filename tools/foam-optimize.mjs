// RANS-in-the-loop optimization: Nelder-Mead (same optimizer as the web app)
// where each objective evaluation is a full OpenFOAM kOmegaSST solve of the
// advanced geometry at the TRUE Reynolds number.
//
// Usage: node tools/foam-optimize.mjs --work <dir> [--mdot 60] [--dx 1.0]
//        [--endTime 2500] [--maxEval 30]
// Progress: appends one line per evaluation to <work>/history.csv;
// best parameters land in <work>/best.json.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nelderMead } from '../js/optimizer.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).join(' ')
  .split('--').filter(Boolean).map(s => {
    const parts = s.trim().split(/\s+/);
    return [parts[0], parts.slice(1).join(' ')];
  }));
const work = args.work;
if (!work) { console.error('need --work <dir>'); process.exit(1); }
mkdirSync(work, { recursive: true });
const mdot = args.mdot || '60';
const dx = args.dx || '1.0';
const endTime = args.endTime || '2500';
const maxEval = parseInt(args.maxEval) || 30;

// free parameters chosen from the RANS punch-through finding: screen strengths
// and positions, plus row-2 vane count (rounded) to break the jet core earlier
const FREE = [
  { key: 'sc1s', lo: 0.3, hi: 0.85, x0: 0.6 },
  { key: 'sc1x', lo: 60, hi: 170, x0: 150 },
  { key: 'sc2s', lo: 0.3, hi: 0.85, x0: 0.4 },
  { key: 'sc2x', lo: 90, hi: 195, x0: 175 },
  { key: 'r2n', lo: 4, hi: 16, x0: 8, int: true },
];

const foam = (cmd, cwd) => execFileSync('openfoam', cmd.split(' '),
  { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30 * 60 * 1000 }).toString();
const node = (script, argv) => execFileSync(process.execPath, [join(here, script), ...argv],
  { stdio: ['ignore', 'pipe', 'pipe'] }).toString();

let evalNo = 0;
writeFileSync(join(work, 'history.csv'),
  ['eval', ...FREE.map(f => f.key), 'uniformity', 'stdOverMean', 'seconds'].join(',') + '\n');

async function objective(x) {
  evalNo++;
  const params = Object.fromEntries(FREE.map((f, i) =>
    [f.key, f.int ? Math.round(x[i]) : +x[i].toFixed(3)]));
  const t0 = Date.now();
  const dir = join(work, 'eval-current');
  rmSync(dir, { recursive: true, force: true });
  let result = { uniformity: 0, stdOverMean: 99 };
  try {
    node('foam-case.mjs', ['--out', dir, '--mdot', mdot, '--dx', dx,
      '--endTime', endTime, '--params', JSON.stringify(params)]);
    foam(`blockMesh -case ${dir}`);
    node('foam-case.mjs', ['--out', dir, '--mdot', mdot, '--dx', dx,
      '--endTime', endTime, '--params', JSON.stringify(params)]);
    foam(`subsetMesh fluid -patch walls -overwrite -case ${dir}`);
    node('foam-case.mjs', ['--fix-boundary', '--out', dir]);
    mkdirSync(join(dir, '0'), { recursive: true });
    for (const f of readdirSync(join(dir, '0org')))
      writeFileSync(join(dir, '0', f), execFileSync('cat', [join(dir, '0org', f)]));
    foam(`simpleFoam -case ${dir}`);
    foam(`postProcess -case ${dir} -func sample -latestTime`);
    result = JSON.parse(node('foam-case.mjs',
      ['--uniformity', join(dir, 'postProcessing', 'sample', endTime, 'exitLine_U.xy')]));
  } catch (e) {
    console.error(`eval ${evalNo} FAILED: ${String(e.message).slice(0, 200)}`);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  const cost = Number.isFinite(result.stdOverMean) ? result.stdOverMean : 99;
  appendFileSync(join(work, 'history.csv'),
    [evalNo, ...FREE.map(f => params[f.key]), result.uniformity ?? 0, cost, secs].join(',') + '\n');
  console.log(`eval ${evalNo}: ${JSON.stringify(params)} -> uniformity ${result.uniformity} (${secs}s)`);
  return cost;
}

const r = await nelderMead(objective, FREE.map(f => f.x0),
  { bounds: FREE.map(f => [f.lo, f.hi]), maxEval, tol: 1e-3, scale: 0.25 });
const best = Object.fromEntries(FREE.map((f, i) =>
  [f.key, f.int ? Math.round(r.x[i]) : +r.x[i].toFixed(3)]));
writeFileSync(join(work, 'best.json'), JSON.stringify(
  { best, uniformity: +Math.max(0, 1 - r.fx).toFixed(4), cost: r.fx, evals: r.evals,
    mdot_gs: +mdot, dx_mm: +dx, endTime: +endTime }, null, 2));
console.log('DONE', JSON.stringify(best), 'uniformity', Math.max(0, 1 - r.fx).toFixed(3));
