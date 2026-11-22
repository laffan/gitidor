// Changes in prose, word by word. Markdown keeps a paragraph on one line, so
// a line diff can only say "this paragraph changed"; here the paragraphs are
// matched first, and the words inside the changed ones second.
//
// Used by the tooltip on a file's change dot, the Commit sheet and the
// Rollback sheet.

export type Part = { kind: "eq" | "del" | "ins"; text: string };

export type Block =
  /** Unchanged paragraphs that are not shown. */
  | { kind: "gap"; count: number }
  /** An unchanged paragraph next to a change, for orientation. */
  | { kind: "context"; text: string }
  /** One or more changed paragraphs, word by word. */
  | { kind: "change"; parts: Part[] };

type Edit = "eq" | "del" | "ins";

/**
 * Myers' O(ND) difference between two sequences, as an edit script. Gives up
 * (answers null) after `maxD` edits, which bounds the memory a wholesale
 * rewrite can take; callers then show it as one deletion and one insertion.
 */
export function myers<T>(a: readonly T[], b: readonly T[], maxD = 1500): Edit[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds v as it was before step d, for k in -d-1 … d+1.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], n: number, m: number): Edit[] {
  const out: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const t = trace[d];
    const at = (k: number) => t[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push("eq");
      x--;
      y--;
    }
    if (d > 0) out.push(x === prevX ? "ins" : "del");
    x = prevX;
    y = prevY;
  }
  return out.reverse();
}

// Runs of space, words (with inner apostrophes), and single other characters.
const TOKEN = /\s+|[\p{L}\p{N}_]+(?:['’][\p{L}\p{N}_]+)*|[^\s\p{L}\p{N}_]/gu;

/** The words of `before` and `after` as unchanged, deleted and inserted runs. */
export function wordDiff(before: string, after: string): Part[] {
  const a = before.match(TOKEN) ?? [];
  const b = after.match(TOKEN) ?? [];
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);

  const parts: Part[] = [];
  if (pre) parts.push({ kind: "eq", text: a.slice(0, pre).join("") });
  const edits = myers(am, bm);
  if (!edits) {
    parts.push({ kind: "del", text: am.join("") }, { kind: "ins", text: bm.join("") });
  } else {
    let i = 0;
    let j = 0;
    for (const e of edits) {
      if (e === "eq") parts.push({ kind: "eq", text: am[i++] }), j++;
      else if (e === "del") parts.push({ kind: "del", text: am[i++] });
      else parts.push({ kind: "ins", text: bm[j++] });
    }
  }
  if (suf) parts.push({ kind: "eq", text: a.slice(a.length - suf).join("") });
  return tidy(parts);
}

/**
 * Make a word diff read the way a person would mark it up: adjacent runs
 * merged; a space, or a word of a letter or two, left unchanged between two
 * changes folded into them ("~~old words~~ new phrase" rather than
 * "~~old~~ new ~~words~~ phrase"); deletions before insertions.
 */
function tidy(parts: Part[]): Part[] {
  const merged: Part[] = [];
  for (const p of parts) {
    if (!p.text) continue;
    const last = merged[merged.length - 1];
    if (last && last.kind === p.kind) last.text += p.text;
    else merged.push({ ...p });
  }
  const out: Part[] = [];
  let cluster: { del: string; ins: string } | null = null;
  const flush = () => {
    if (!cluster) return;
    if (cluster.del) out.push({ kind: "del", text: cluster.del });
    if (cluster.ins) out.push({ kind: "ins", text: cluster.ins });
    cluster = null;
  };
  for (let i = 0; i < merged.length; i++) {
    const p = merged[i];
    if (p.kind !== "eq") {
      cluster ??= { del: "", ins: "" };
      cluster[p.kind] += p.text;
      continue;
    }
    const between = cluster && i + 1 < merged.length && !p.text.includes("\n") && p.text.trim().length <= 2;
    if (between && cluster) {
      cluster.del += p.text;
      cluster.ins += p.text;
      continue;
    }
    flush();
    out.push(p);
  }
  flush();
  return out;
}

/**
 * The changes between two versions of a post: each changed run of paragraphs
 * word by word, `context` unchanged paragraphs either side of it, and the
 * rest counted. Empty when nothing changed.
 */
export function proseDiff(before: string, after: string, context = 1): Block[] {
  // An empty file has no lines, not one empty line that would match the
  // blank lines between a new post's paragraphs.
  const a = before ? before.split("\n") : [];
  const b = after ? after.split("\n") : [];
  const edits = myers(a, b, 4000) ?? [...a.map(() => "del" as const), ...b.map(() => "ins" as const)];

  type Run = { kind: "eq"; lines: string[] } | { kind: "change"; del: string[]; ins: string[] };
  const runs: Run[] = [];
  let i = 0;
  let j = 0;
  for (const e of edits) {
    const last = runs[runs.length - 1];
    if (e === "eq") {
      if (last?.kind === "eq") last.lines.push(a[i]);
      else runs.push({ kind: "eq", lines: [a[i]] });
      i++;
      j++;
    } else {
      const run = last?.kind === "change" ? last : (runs.push({ kind: "change", del: [], ins: [] }), runs[runs.length - 1] as Extract<Run, { kind: "change" }>);
      if (e === "del") run.del.push(a[i++]);
      else run.ins.push(b[j++]);
    }
  }
  if (!runs.some((r) => r.kind === "change")) return [];

  const blocks: Block[] = [];
  runs.forEach((run, n) => {
    if (run.kind === "change") {
      const parts = wordDiff(run.del.join("\n"), run.ins.join("\n"));
      if (parts.some((p) => p.kind !== "eq")) blocks.push({ kind: "change", parts });
      return;
    }
    const paras = run.lines.filter((l) => l.trim());
    const afterChange = n > 0;
    const beforeChange = n < runs.length - 1;
    const head = afterChange ? paras.slice(0, context) : [];
    const tail = beforeChange ? paras.slice(Math.max(head.length, paras.length - context)) : [];
    const hidden = paras.length - head.length - tail.length;
    for (const t of head) blocks.push({ kind: "context", text: t });
    if (hidden > 0) blocks.push({ kind: "gap", count: hidden });
    for (const t of tail) blocks.push({ kind: "context", text: t });
  });
  return blocks;
}

/** How many words were added and removed, for a one-line summary. */
export function countWords(blocks: Block[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const b of blocks) {
    if (b.kind !== "change") continue;
    for (const p of b.parts) {
      const n = (p.text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
      if (p.kind === "ins") added += n;
      if (p.kind === "del") removed += n;
    }
  }
  return { added, removed };
}
