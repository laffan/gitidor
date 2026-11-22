// Frontmatter in either of the two forms static sites use: YAML between `---`
// fences (Jekyll, Eleventy, Astro, most Hugo sites) or TOML between `+++`
// (Hugo's other convention). Parsed for display and for new-post templates;
// the editor never rewrites a file's frontmatter on its own.

import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from "yaml";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

export type FrontFormat = "yaml" | "toml";

export interface Frontmatter {
  format: FrontFormat;
  /** The text between the fences. */
  raw: string;
  /** Offset of the first character after the closing fence's line. */
  end: number;
  data: Record<string, unknown>;
  error: string | null;
}

/** Where the frontmatter block is, if the text opens with one. */
export function findFrontmatter(text: string): { format: FrontFormat; rawStart: number; rawEnd: number; end: number } | null {
  const bom = text.startsWith("﻿") ? 1 : 0;
  const first = text.slice(bom, bom + 4);
  const format: FrontFormat | null = /^---\r?\n/.test(text.slice(bom, bom + 5)) || first === "---\n" ? "yaml" : /^\+\+\+\r?\n/.test(text.slice(bom, bom + 5)) ? "toml" : null;
  if (!format) return null;
  const fence = format === "yaml" ? "---" : "+++";
  const rawStart = text.indexOf("\n", bom) + 1;
  let pos = rawStart;
  while (pos <= text.length) {
    const next = text.indexOf("\n", pos);
    const lineEnd = next < 0 ? text.length : next;
    const line = text.slice(pos, lineEnd).replace(/\r$/, "");
    if (line === fence || (format === "yaml" && line === "...")) {
      return { format, rawStart, rawEnd: pos, end: next < 0 ? text.length : next + 1 };
    }
    if (next < 0) break;
    pos = next + 1;
  }
  return null;
}

export function parseFrontmatter(text: string): Frontmatter | null {
  const found = findFrontmatter(text);
  if (!found) return null;
  const raw = text.slice(found.rawStart, found.rawEnd);
  let data: Record<string, unknown> = {};
  let error: string | null = null;
  try {
    const parsed = found.format === "yaml" ? parseYaml(raw) : parseToml(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch (e) {
    error = (e as Error).message;
  }
  return { format: found.format, raw, end: found.end, data, error };
}

export interface FrontmatterIssue {
  /** 1-based line number in the whole file. */
  line: number;
  message: string;
}

/** Plain-language versions of the YAML parser's error codes. */
const YAML_MESSAGES: Record<string, string> = {
  MULTILINE_IMPLICIT_KEY: "Expected “key: value” — is a colon missing?",
  DUPLICATE_KEY: "This key is already used above.",
  TAB_AS_INDENT: "Tabs can't indent YAML; use spaces.",
  MISSING_CHAR: "A quote or bracket is opened here and not closed.",
  BAD_INDENT: "The indentation doesn't fit here.",
  BAD_DQ_ESCAPE: "Invalid escape inside double quotes.",
  UNEXPECTED_TOKEN: "Unexpected character.",
};

/**
 * Lines worth suspecting, for placing an error the parser reports across a
 * range. These never mark anything by themselves — YAML allows more than a
 * line-by-line look can judge — they only say which line in a reported
 * range is most likely the one to fix.
 */
function suspiciousLines(lines: string[]): Set<number> {
  const out = new Set<number>();
  let opener = false; // the previous content line opened a block (`key:` or `- `)
  let prevIndent = 0;
  lines.forEach((line, i) => {
    if (!line.trim() || line.trimStart().startsWith("#")) return;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    if (/^\t/.test(line)) out.add(i);
    else if (indent > prevIndent && !opener) out.add(i);
    else if (indent === 0 && !/^-(\s|$)/.test(body) && !/^[^:#]+:(\s|$)/.test(body) && !/^["'][^"']*["']\s*:(\s|$)/.test(body)) out.add(i);
    const unbalanced = (q: string) => (body.split(q).length - 1 - (body.match(new RegExp(`\\\\${q}`, "g"))?.length ?? 0)) % 2 === 1;
    if (unbalanced('"') || (/:\s+'/.test(body) && unbalanced("'"))) out.add(i);
    if ((body.match(/\[/g)?.length ?? 0) > (body.match(/\]/g)?.length ?? 0)) out.add(i);
    if (/^[^:"']+:\s+[^"'\s][^#]*:\s/.test(body)) out.add(i);
    opener = /:\s*([|>][-+]?)?$/.test(body) || /^-(\s|$)/.test(body);
    prevIndent = indent;
  });
  return out;
}

/**
 * Where a file's frontmatter does not parse, line by line. YAML reports every
 * error it finds; TOML (smol-toml) stops at the first.
 */
export function frontmatterIssues(text: string): FrontmatterIssue[] {
  const found = findFrontmatter(text);
  if (!found) return [];
  const raw = text.slice(found.rawStart, found.rawEnd);
  const firstLine = text.slice(0, found.rawStart).split("\n").length; // 1-based line of raw's first line
  const lines = raw.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const lastContent = Math.max(0, lines.length - 1);
  const lineOf = (offset: number) => Math.min(raw.slice(0, Math.max(0, offset)).split("\n").length - 1, lastContent);
  const issues = new Map<number, string>();

  if (found.format === "toml") {
    try {
      parseToml(raw);
    } catch (e) {
      const err = e as { line?: number; message?: string };
      const line = Math.min(Math.max(1, err.line ?? 1), lines.length || 1) - 1;
      issues.set(line, (err.message ?? "Invalid TOML").split("\n")[0].replace(/^Invalid TOML document:\s*/, ""));
    }
  } else {
    const doc = parseDocument(raw, { prettyErrors: false, uniqueKeys: true });
    const suspects = suspiciousLines(lines);
    for (const err of doc.errors) {
      const from = lineOf(err.pos[0]);
      const to = lineOf(Math.max(err.pos[0], err.pos[1] - 1));
      let line = from;
      const inRange = [...suspects].filter((l) => l >= from && l <= to).sort((a, b) => a - b);
      if (inRange.length) line = inRange[0];
      // Reported on a line that looks fine, just before one that doesn't:
      // how an over-indented line shows up (the error lands on its parent).
      else if (suspects.has(from + 1)) line = from + 1;
      else if (err.code === "MISSING_CHAR" || err.code === "BAD_INDENT") {
        const before = [...suspects].filter((l) => l <= from).sort((a, b) => b - a);
        if (before.length) line = before[0];
      }
      const plain =
        err.code === "BLOCK_AS_IMPLICIT_KEY"
          ? /^[^:]+:\s+[^"'].*:\s/.test(lines[line]?.trim() ?? "")
            ? "A value containing “: ” has to be in quotes."
            : "The indentation doesn't match the line above."
          : (YAML_MESSAGES[err.code] ?? err.message);
      if (!issues.has(line)) issues.set(line, plain);
    }
  }
  return [...issues.entries()].sort((a, b) => a[0] - b[0]).map(([line, message]) => ({ line: firstLine + line, message }));
}

/** The text after the frontmatter. */
export function body(text: string): string {
  const found = findFrontmatter(text);
  return found ? text.slice(found.end) : text;
}

export function todayIso(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * A new post's text, shaped like the newest post in the folder: the same
 * frontmatter format, and the same string fields left empty to fill in. The
 * title and date are set; lists come over empty; anything else is left out
 * rather than copied, since a copied `draft: false` or `featured: true` is a
 * decision nobody made.
 */
export function newPostText(sample: string | null, title: string, date: string): string {
  const fm = sample ? parseFrontmatter(sample) : null;
  const format: FrontFormat = fm?.format ?? "yaml";
  const out: Record<string, unknown> = {};
  const keys = fm && !fm.error ? Object.keys(fm.data) : ["title", "date"];
  if (!keys.includes("title")) keys.unshift("title");
  if (!keys.some((k) => k.toLowerCase() === "date")) keys.splice(1, 0, "date");
  for (const key of keys) {
    const sampleValue = fm?.data[key];
    if (key === "title") out[key] = title;
    else if (key.toLowerCase() === "date") out[key] = date;
    else if (Array.isArray(sampleValue)) out[key] = [];
    else if (typeof sampleValue === "string") out[key] = "";
  }
  if (format === "toml") {
    return `+++\n${stringifyToml(out).trim()}\n+++\n\n`;
  }
  // Dates as plain scalars, the way people write them by hand.
  const yaml = stringifyYaml(out, { lineWidth: 0 }).replace(/^(date: )"(\d{4}-\d{2}-\d{2})"$/m, "$1$2");
  return `---\n${yaml.trim()}\n---\n\n`;
}

/**
 * A file name in the folder's own convention: if most names start with a
 * date (`2010-03-14--crickets.md`, `2024-02-29-leap.md`), so does this one,
 * with the same separator; the extension is whichever the folder uses most.
 */
export function newPostName(existing: string[], title: string, date: string): string {
  const slug = slugify(title) || "untitled";
  const exts = new Map<string, number>();
  const seps = new Map<string, number>();
  let dated = 0;
  for (const name of existing) {
    const ext = /\.(md|markdown|mdx)$/i.exec(name)?.[1]?.toLowerCase();
    if (ext) exts.set(ext, (exts.get(ext) ?? 0) + 1);
    const m = /^\d{4}-\d{2}-\d{2}(-+)/.exec(name);
    if (m) {
      dated++;
      seps.set(m[1], (seps.get(m[1]) ?? 0) + 1);
    }
  }
  const top = (m: Map<string, number>, fallback: string) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallback;
  const ext = top(exts, "md");
  const useDate = existing.length > 0 ? dated / existing.length > 0.5 : false;
  return useDate ? `${date}${top(seps, "-")}${slug}.${ext}` : `${slug}.${ext}`;
}
