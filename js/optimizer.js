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
