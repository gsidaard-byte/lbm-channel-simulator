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
