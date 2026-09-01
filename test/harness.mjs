export const tests = [];
export function test(name, fn) { tests.push({ name, fn }); }
export function ok(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }
export function approx(actual, expected, tol, msg = '') {
  if (!(Math.abs(actual - expected) <= tol))
    throw new Error(`${msg} expected ${expected}±${tol}, got ${actual}`);
}
