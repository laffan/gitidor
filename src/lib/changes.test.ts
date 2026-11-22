import { describe, expect, it } from "vitest";
import previewSource from "../ui/preview.ts?raw";
import schemeSource from "../../src-tauri/src/scheme.rs?raw";
import { countWords, myers, proseDiff, wordDiff } from "./diff";
import { locate } from "./locate";
import { pageShows } from "./published";

describe("myers", () => {
  it("gives an edit script that turns one sequence into the other", () => {
    const pick = (n: number, seed: number) => Array.from({ length: n }, (_, i) => "abcde"[(i * 7 + seed * 13 + ((i * seed) % 5)) % 5]);
    for (let seed = 1; seed < 40; seed++) {
      const a = pick(5 + (seed % 17), seed);
      const b = pick(3 + ((seed * 3) % 19), seed + 7);
      const edits = myers(a, b)!;
      const out: string[] = [];
      let i = 0;
      let j = 0;
      for (const e of edits) {
        if (e === "eq") {
          expect(a[i]).toBe(b[j]);
          out.push(a[i]);
          i++;
          j++;
        } else if (e === "del") i++;
        else out.push(b[j++]);
      }
      expect(out).toEqual(b);
      expect(i).toBe(a.length);
    }
  });

  it("gives up past its limit rather than use unbounded memory", () => {
    expect(myers(["a", "b", "c"], ["x", "y", "z"], 2)).toBeNull();
  });
});

describe("wordDiff", () => {
  it("marks the changed word only", () => {
    expect(wordDiff("The cat sat down.", "The dog sat down.")).toEqual([
      { kind: "eq", text: "The " },
      { kind: "del", text: "cat" },
      { kind: "ins", text: "dog" },
      { kind: "eq", text: " sat down." },
    ]);
  });

  it("reads a rewritten phrase as one change, not alternating words", () => {
    expect(wordDiff("Some old words here.", "Some new phrase here.")).toEqual([
      { kind: "eq", text: "Some " },
      { kind: "del", text: "old words" },
      { kind: "ins", text: "new phrase" },
      { kind: "eq", text: " here." },
    ]);
  });

  it("shows an insertion and a deletion in the same sentence", () => {
    const parts = wordDiff("There is a bench at the top.", "There is a worn bench at the very top.");
    expect(parts.filter((p) => p.kind === "ins").map((p) => p.text.trim())).toEqual(["worn", "very"]);
    expect(parts.some((p) => p.kind === "del")).toBe(false);
  });
});

describe("proseDiff", () => {
  const before = ["---", "title: Marettimo", "---", "First paragraph.", "", "Second paragraph has a bench.", "", "Third.", "", "Fourth.", "", "Fifth."].join("\n");

  it("is empty when nothing changed", () => {
    expect(proseDiff(before, before)).toEqual([]);
  });

  it("shows the changed paragraph word by word, with a paragraph of context and the rest counted", () => {
    const after = before.replace("has a bench", "has a worn bench");
    const blocks = proseDiff(after === before ? "" : before, after);
    expect(blocks).toEqual([
      { kind: "gap", count: 3 },
      { kind: "context", text: "First paragraph." },
      { kind: "change", parts: [{ kind: "eq", text: "Second paragraph has a " }, { kind: "ins", text: "worn " }, { kind: "eq", text: "bench." }] },
      { kind: "context", text: "Third." },
      { kind: "gap", count: 2 },
    ]);
    expect(countWords(blocks)).toEqual({ added: 1, removed: 0 });
  });

  it("shows a new file as one insertion", () => {
    const blocks = proseDiff("", "# Hello\n\nA new post.");
    expect(blocks).toHaveLength(1);
    expect(countWords(blocks)).toEqual({ added: 4, removed: 0 });
  });
});

const POST = `---
title: Marettimo
date: 2026-11-02
---
The ferry from Trapani takes an hour and a half, and for the last twenty minutes the island sits on the horizon.

![The harbour at dusk | wide](/images/blog/marettimo-harbour.jpg)

We arrived with no plan beyond the walk to the lighthouse. The **path** climbs out of the village past a chapel and then simply *keeps going*, as [the guide](https://example.com/guide) said it would.

## The lighthouse

There is a bench at the top. The path ends at the lighthouse.
`;

describe("locate", () => {
  it("finds a word clicked in the middle, through markdown emphasis", () => {
    const pos = locate(POST, { before: "We arrived with no plan beyond the walk to the lighthouse. The pa", after: "th climbs out of the village past a chapel" });
    expect(pos).toBe(POST.indexOf("**path**") + 2 + 2);
  });

  it("tells repeated words apart by the words around them", () => {
    const pos = locate(POST, { before: "There is a bench at the top. The ", after: "path ends at the lighthouse." });
    expect(pos).toBe(POST.lastIndexOf("path ends"));
  });

  it("skips link targets the rendered text does not have", () => {
    const pos = locate(POST, { before: "simply keeps going, as the guide ", after: "said it would." });
    expect(pos).toBe(POST.indexOf("said it would"));
  });

  it("finds a heading rather than the same words inside a paragraph", () => {
    const heading = POST.indexOf("## The lighthouse") + "## The ".length;
    expect(locate(POST, { before: "The ", after: "lighthouse", ratio: 0.8 })).toBe(heading);
    // A click past the end of the heading, with a misleading ratio.
    expect(locate(POST, { before: "The lighthouse", after: "", ratio: 0.1 })).toBe(heading + "lighthouse".length);
  });

  it("answers null for text the post does not have", () => {
    expect(locate(POST, { before: "Posted in travel by ", after: "someone else entirely" })).toBeNull();
  });
});

describe("pageShows", () => {
  const template = (body: string) => `Home Blog About\n${body}\n© 2026 · Subscribe by RSS`;
  const previous = "Marettimo\nThere is a bench at the top. Someone has carved a date into it.";
  const current = "Marettimo\nThere is a worn bench at the top. Someone has carved a date into it.";

  it("is false while the page has the old version", () => {
    expect(pageShows(current, previous, template(previous))).toBe(false);
  });

  it("is true once the page has the new version, template and all", () => {
    expect(pageShows(current, previous, template(current))).toBe(true);
  });

  it("is true when rendering differences hit both versions alike", () => {
    // The site renders a caption the draft does not have and drops a word.
    const page = template(current.replace("a date", "a").concat(" Photo: the harbour."));
    expect(pageShows(current, previous, page)).toBe(true);
  });

  it("is false for a new post until its page exists", () => {
    expect(pageShows(current, null, "Page not found")).toBe(false);
    expect(pageShows(current, null, template(current))).toBe(true);
  });
});

describe("the click script", () => {
  it("is the same in the draft preview and in live pages", () => {
    const fromTs = /String\.raw`(function gitidorLocate[\s\S]*?)`;/.exec(previewSource)?.[1];
    const fromRs = /r#"(function gitidorLocate[\s\S]*?)"#;/.exec(schemeSource)?.[1];
    expect(fromTs).toBeTruthy();
    expect(fromTs).toBe(fromRs);
  });
});
