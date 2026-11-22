// Clicking text in the preview moves the editor there. The preview reports
// the text of the clicked paragraph before and after the click; this finds
// those words in the markdown, which has syntax the rendered text does not
// (`**`, link targets, image references), so it matches words, not
// characters: the clicked word, scored by how many of the words around it
// appear around it in the source too, and by whether a paragraph that
// starts or ends near the click starts or ends there in the source as well
// (in markdown a paragraph or heading is one line).

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

interface Token {
  word: string;
  from: number;
  to: number;
  /** Which line of the text it is on. */
  line: number;
}

function tokens(text: string): Token[] {
  let line = 0;
  let scanned = 0;
  return [...text.matchAll(WORD)].map((m) => {
    const from = m.index ?? 0;
    for (; scanned < from; scanned++) if (text.charCodeAt(scanned) === 10) line++;
    return { word: m[0], from, to: from + m[0].length, line };
  });
}

const norm = (w: string) => w.toLowerCase().replace(/’/g, "'");

/** Longest common subsequence length, for a handful of words. */
function lcs(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    prev = row;
  }
  return prev[b.length];
}

export interface Clicked {
  /** The clicked block's text up to the click. */
  before: string;
  /** The clicked block's text from the click on. */
  after: string;
  /** How far through the page the click was, 0–1; breaks ties. */
  ratio?: number;
}

const CONTEXT = 6;
const WINDOW = 12;

/** The offset in `source` matching the click, or null when nothing matches well enough. */
export function locate(source: string, click: Clicked): number | null {
  const before = tokens(click.before);
  const after = tokens(click.after);
  const insideWord = before.length > 0 && after.length > 0 && /[\p{L}\p{N}]$/u.test(click.before) && /^[\p{L}\p{N}]/u.test(click.after);

  let words: string[];
  let anchor: number;
  let within: number;
  if (insideWord) {
    const left = before[before.length - 1].word;
    words = [...before.slice(0, -1).map((t) => t.word), left + after[0].word, ...after.slice(1).map((t) => t.word)];
    anchor = before.length - 1;
    within = left.length;
  } else if (after.length) {
    words = [...before, ...after].map((t) => t.word);
    anchor = before.length;
    within = 0;
  } else if (before.length) {
    words = before.map((t) => t.word);
    anchor = before.length - 1;
    within = words[anchor].length;
  } else {
    return null;
  }
  const start = Math.max(0, anchor - CONTEXT);
  // Whether the window reaches the clicked paragraph's first and last words.
  const blockStart = start === 0;
  const blockEnd = anchor + CONTEXT + 1 >= words.length;
  words = words.slice(start, anchor + CONTEXT + 1).map(norm);
  anchor -= start;

  const src = tokens(source);
  const srcWords = src.map((t) => norm(t.word));
  const others = words.length - 1;
  const needed = 1 + Math.min(2, others);

  // The clicked word first; if the source spells it differently, its
  // neighbours, nearest first.
  const anchors = [anchor];
  for (let d = 1; anchors.length < 3 && d < words.length; d++) {
    if (anchor + d < words.length) anchors.push(anchor + d);
    if (anchors.length < 3 && anchor - d >= 0) anchors.push(anchor - d);
  }

  for (const at of anchors) {
    const left = words.slice(0, at);
    const right = words.slice(at + 1);
    let best = -1;
    let bestScore = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < srcWords.length; i++) {
      if (srcWords[i] !== words[at]) continue;
      let score = 1 + lcs(left, srcWords.slice(Math.max(0, i - WINDOW), i)) + lcs(right, srcWords.slice(i + 1, i + 1 + WINDOW));
      // A paragraph that starts (or ends) in the window should start (or
      // end) on this line, with the same word.
      if (blockStart) {
        let first = i;
        while (first > 0 && src[first - 1].line === src[i].line) first--;
        if (srcWords[first] === words[0] && i - first <= WINDOW) score++;
      }
      if (blockEnd) {
        let last = i;
        while (last + 1 < src.length && src[last + 1].line === src[i].line) last++;
        if (srcWords[last] === words[words.length - 1] && last - i <= WINDOW) score++;
      }
      const distance = click.ratio === undefined ? 0 : Math.abs(src[i].from / Math.max(1, source.length) - click.ratio);
      if (score > bestScore || (score === bestScore && distance < bestDistance)) {
        best = i;
        bestScore = score;
        bestDistance = distance;
      }
    }
    if (best >= 0 && bestScore >= needed) {
      const t = src[best];
      return at === anchor ? Math.min(t.from + within, t.to) : t.from;
    }
  }
  return null;
}
