// Whether the live page shows a post's latest version yet. After a push the
// site takes a while to rebuild; until it has, the live preview says so.
//
// The page has its template around the post (navigation, footer) and the
// site's generator renders some things differently from the draft preview,
// so the page is never word-for-word the post. Rather than ask "is every
// word there?", this asks which version the page is closer to: runs of three
// words from the post as it is now and as GitHub had it before the push,
// counted against the page. Differences in rendering affect both versions
// alike and cancel out; the words the push changed decide it.

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

export function words(text: string): string[] {
  return (text.match(WORD) ?? []).map((w) => w.toLowerCase().replace(/’/g, "'"));
}

function shingles(list: string[]): Set<string> {
  const out = new Set<string>();
  if (list.length < 3) {
    if (list.length) out.add(list.join(" "));
    return out;
  }
  for (let i = 0; i + 3 <= list.length; i++) out.add(`${list[i]} ${list[i + 1]} ${list[i + 2]}`);
  return out;
}

function missing(of: Set<string>, page: Set<string>): number {
  let n = 0;
  for (const s of of) if (!page.has(s)) n++;
  return n;
}

/**
 * Does `page` (its visible text) show `current` rather than `previous`?
 * Both are a post's text as the reader sees it. `previous` null means the
 * post is new: then the page shows it when nearly all of it is there.
 * When the change is not visible in the text at all, the answer is yes —
 * there is nothing to wait for.
 */
export function pageShows(current: string, previous: string | null, page: string): boolean {
  const onPage = shingles(words(page));
  const now = shingles(words(current));
  const missNow = missing(now, onPage);
  if (missNow === 0) return true;
  if (previous === null) return missNow <= now.size * 0.1;
  return missNow <= missing(shingles(words(previous)), onPage);
}
