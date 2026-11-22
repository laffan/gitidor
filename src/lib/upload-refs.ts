// Frontmatter that names a file in an upload folder — `image:
// /images/blog/harbour.jpg`, `cover: "my photo.png"`, `attachments: [a.pdf,
// b.mp3]` — gets a small button beside the name in the editor. This finds
// the names on a line and the upload each one means.

import type { UploadEntry } from "./types";

export interface Candidate {
  /** The name as written, without quotes. */
  text: string;
  /** Where it is in the line. */
  from: number;
  to: number;
}

const ENDS_IN_FILE = /\.[A-Za-z0-9]{2,5}$/;
const TOKEN = /"([^"\n]*)"|'([^'\n]*)'|([^\s,[\]{}()"'<>|]+)/g;

/**
 * The values on a frontmatter line that end in a file name: quoted strings
 * whole (so a name may have spaces), otherwise runs between spaces, commas
 * and brackets. Only what follows the key (`key:` in YAML, `key =` in TOML)
 * or a list dash counts.
 */
export function fileCandidates(line: string): Candidate[] {
  const key = /^\s*(?:-\s+)?(?:[\w.-]+|"[^"]*"|'[^']*')\s*[:=](?:\s|$)/.exec(line);
  const dash = /^\s*-\s+/.exec(line);
  const start = key ? key[0].length : dash ? dash[0].length : 0;
  const out: Candidate[] = [];
  TOKEN.lastIndex = start;
  for (let m = TOKEN.exec(line); m; m = TOKEN.exec(line)) {
    if (m.index < start) continue;
    const quoted = m[1] ?? m[2];
    const text = (quoted ?? m[3] ?? "").trim();
    const bare = text.split(/[?#]/)[0];
    if (!bare || !ENDS_IN_FILE.test(bare)) continue;
    const from = m.index + (quoted !== undefined ? 1 : 0) + (quoted ?? m[3] ?? "").indexOf(text);
    out.push({ text, from, to: from + text.length });
  }
  return out;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * The upload `name` means. First as the site resolves it (`resolveLocal`
 * turns a site URL or a path relative to the post into a repository path);
 * failing that, by file name, preferring the file whose path shares the most
 * trailing folders with what was written. A link to another site never
 * matches by name.
 */
export function matchUpload(name: string, uploads: readonly UploadEntry[], resolveLocal?: (ref: string) => string | null): UploadEntry | null {
  const local = resolveLocal?.(name);
  if (local) {
    const exact = uploads.find((u) => u.path === local);
    if (exact) return exact;
  }
  if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(name)) return null;
  const clean = decode(name.split(/[?#]/)[0]).replace(/^\.\//, "");
  const parts = clean.split("/").filter(Boolean);
  const base = parts[parts.length - 1];
  if (!base) return null;
  let same = uploads.filter((u) => u.name === base);
  if (!same.length) same = uploads.filter((u) => u.name.toLowerCase() === base.toLowerCase());
  if (same.length < 2) return same[0] ?? null;
  const shared = (u: UploadEntry) => {
    const theirs = u.path.split("/");
    let n = 0;
    while (n < parts.length && n < theirs.length && parts[parts.length - 1 - n] === theirs[theirs.length - 1 - n]) n++;
    return n;
  };
  return same.reduce((best, u) => (shared(u) > shared(best) ? u : best));
}
