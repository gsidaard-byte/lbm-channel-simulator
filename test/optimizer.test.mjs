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
