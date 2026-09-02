import { tests } from './harness.mjs';
const mods = ['./units.test.mjs', './geometry.test.mjs', './geometry-adv.test.mjs', './geometry-ch.test.mjs', './lbm.test.mjs', './optimizer.test.mjs'];
for (const m of mods) {
  try { await import(m); }
  catch (e) {
    // Only skip test files that don't exist yet; a missing import INSIDE a
    // test file is a real failure.
    const missing = String(e.message).split(' imported from')[0];
    if (e.code === 'ERR_MODULE_NOT_FOUND' && missing.includes(m.slice(2))) continue;
    throw e;
  }
}
let fail = 0;
for (const t of tests) {
  try { await t.fn(); console.log('PASS', t.name); }
  catch (e) { fail++; console.error('FAIL', t.name, '-', e.message); }
}
console.log(`${tests.length - fail}/${tests.length} passed`);
process.exit(fail ? 1 : 0);
