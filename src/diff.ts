// Line diff for snapshots. Refs are stable across snapshots, so unchanged elements produce identical lines
// and only what actually changed comes back.

type Op = { t: "=" | "+" | "-"; line: string; a: number };

/** Myers O(ND) diff over lines. */
export function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length, m = b.length, max = n + m;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[max + k - 1] < v[max + k + 1]) ? v[max + k + 1] : v[max + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[max + k] = x;
      if (x >= n && y >= m) break outer;
    }
  }
  const ops: Op[] = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vv = trace[d], k = x - y;
    const prevK = k === -d || (k !== d && vv[max + k - 1] < vv[max + k + 1]) ? k + 1 : k - 1;
    const px = vv[max + prevK], py = px - prevK;
    while (x > px && y > py) { x--; y--; ops.push({ t: "=", line: a[x], a: x }); }
    if (d === 0) break;
    if (x === px) { y--; ops.push({ t: "+", line: b[y], a: x }); }
    else { x--; ops.push({ t: "-", line: a[x], a: x }); }
  }
  while (x > 0 && y > 0) { x--; y--; ops.push({ t: "=", line: a[x], a: x }); }
  return ops.reverse();
}

const indent = (s: string) => s.length - s.trimStart().length;

/** Render a compact diff: changed lines with +/-, each hunk preceded by its nearest unchanged ancestor line. */
export function renderDiff(prev: string[], next: string[]): { text: string; added: number; removed: number; same: number } {
  const ops = diffLines(prev, next);
  let added = 0, removed = 0, same = 0;
  const out: string[] = [];
  let lastShownCtx = -1;
  let inHunk = false;
  const ctxStack: { line: string; ind: number; idx: number }[] = [];
  ops.forEach((op, i) => {
    if (op.t === "=") {
      same++;
      const ind = indent(op.line);
      while (ctxStack.length && ctxStack[ctxStack.length - 1].ind >= ind) ctxStack.pop();
      ctxStack.push({ line: op.line, ind, idx: i });
      inHunk = false;
      return;
    }
    op.t === "+" ? added++ : removed++;
    if (!inHunk) {
      const ind = indent(op.line);
      const parent = [...ctxStack].reverse().find((c) => c.ind < ind);
      if (out.length) out.push("  …");
      if (parent && parent.idx !== lastShownCtx) { out.push(`  ${parent.line}`); lastShownCtx = parent.idx; }
      inHunk = true;
    }
    out.push(`${op.t} ${op.line}`);
  });
  return { text: out.join("\n"), added, removed, same };
}
