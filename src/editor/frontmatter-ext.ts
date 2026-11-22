// Frontmatter in the editor.
//
// Two jobs. First, keep the markdown parser out of it: to CommonMark, a
// `---` block at the top of a file is a horizontal rule followed by a setext
// heading (`title: Crickets` underlined by the closing `---`), so without
// this the frontmatter renders as a bold H2. A block parser claims it first.
//
// Second, draw it the way the Appearance setting asks: dimmed (the default,
// readable but quieter than the post), folded to a one-line summary that
// opens when the caret goes into it, or shown like the rest of the text.

import type { MarkdownConfig } from "@lezer/markdown";
import { EditorState, Facet, RangeSetBuilder, StateField, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { findFrontmatter, parseFrontmatter } from "../lib/frontmatter";

const SCAN = 64 * 1024;

export const FrontmatterBlock: MarkdownConfig = {
  defineNodes: [{ name: "Frontmatter", block: true }],
  parseBlock: [
    {
      name: "Frontmatter",
      before: "HorizontalRule",
      parse(cx, line) {
        if (cx.lineStart !== 0) return false;
        // The document text, to see whether a closing fence exists before
        // claiming any lines (a parser cannot give lines back). `input` is
        // on every BlockContext but is not in @lezer/markdown's typings.
        const input = (cx as unknown as { input?: { read(from: number, to: number): string; length: number } }).input;
        if (!input) return false;
        const head = input.read(0, Math.min(input.length, SCAN));
        const found = findFrontmatter(head);
        if (!found) return false;
        const end = found.end - (head[found.end - 1] === "\n" ? 1 : 0);
        while (cx.lineStart + line.text.length < end && cx.nextLine()) {
          /* consume the block's lines */
        }
        cx.addElement(cx.elt("Frontmatter", 0, end));
        cx.nextLine();
        return true;
      },
    },
  ],
};

export type FrontmatterMode = "dim" | "fold" | "show";

export const frontmatterMode = Facet.define<FrontmatterMode, FrontmatterMode>({
  combine: (values) => values[0] ?? "dim",
});

class FoldWidget extends WidgetType {
  constructor(readonly summary: string) {
    super();
  }
  eq(other: FoldWidget) {
    return other.summary === this.summary;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    const chip = document.createElement("span");
    chip.className = "cm-frontmatter-fold";
    chip.textContent = this.summary;
    chip.title = "Show frontmatter";
    chip.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: 4 } });
      view.focus();
    });
    el.appendChild(chip);
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

function build(state: EditorState): DecorationSet {
  const head = state.sliceDoc(0, Math.min(state.doc.length, SCAN));
  const found = findFrontmatter(head);
  if (!found) return Decoration.none;
  const mode = state.facet(frontmatterMode);
  const end = found.end - (head[found.end - 1] === "\n" ? 1 : 0);
  const sel = state.selection.main;
  const inside = sel.from <= end && sel.to >= 0 && sel.from < found.end;
  const builder = new RangeSetBuilder<Decoration>();

  if (mode === "fold" && !inside) {
    const fm = parseFrontmatter(head);
    const keys = fm ? Object.keys(fm.data) : [];
    const title = fm && typeof fm.data.title === "string" ? fm.data.title : "";
    const summary = `${found.format === "yaml" ? "YAML" : "TOML"} · ${title ? `“${title}” · ` : ""}${keys.length} field${keys.length === 1 ? "" : "s"}`;
    builder.add(0, end, Decoration.replace({ widget: new FoldWidget(summary), block: true }));
    return builder.finish();
  }

  const fm = parseFrontmatter(head);
  const lineClass = `cm-frontmatter${mode === "show" ? " show" : ""}`;
  const keyRe = found.format === "yaml" ? /^([\w.-]+)(\s*:)/ : /^([\w.-]+)(\s*=)/;
  for (let pos = 0; pos <= end; ) {
    const line = state.doc.lineAt(pos);
    const fence = line.from === 0 || line.to >= end;
    builder.add(line.from, line.from, Decoration.line({ class: `${lineClass}${fence ? " cm-frontmatter-fence" : ""}${fm?.error && line.from === 0 ? " cm-frontmatter-error" : ""}`, attributes: fm?.error && line.from === 0 ? { title: fm.error } : {} }));
    const m = !fence ? keyRe.exec(line.text) : null;
    if (m) builder.add(line.from, line.from + m[1].length, Decoration.mark({ class: "cm-frontmatter-key" }));
    if (line.to + 1 > end) break;
    pos = line.to + 1;
  }
  return builder.finish();
}

export function frontmatterDecorations(): Extension {
  return StateField.define<DecorationSet>({
    create: build,
    update(value, tr) {
      if (tr.docChanged || tr.selection || tr.startState.facet(frontmatterMode) !== tr.state.facet(frontmatterMode)) return build(tr.state);
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}
