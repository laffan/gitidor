// A small button after a frontmatter value that names a file in one of the
// repository's upload folders (`image: /images/blog/harbour.jpg`). Resting
// the pointer on it shows the file; clicking goes to it. What counts as an
// upload, and what hovering and clicking do, come from the app through the
// `uploadLinker` facet, so the editor knows nothing about folders.

import { Facet, RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { findFrontmatter } from "../lib/frontmatter";
import { fileCandidates } from "../lib/upload-refs";
import { icon } from "../lib/dom";

export interface UploadLink {
  path: string;
  name: string;
  kind: "image" | "video" | "audio" | "file";
}

export interface UploadLinker {
  /** The upload a written name means, if any. */
  find(name: string): UploadLink | null;
  hover(anchor: HTMLElement, link: UploadLink): void;
  leave(): void;
  open(link: UploadLink): void;
}

export const uploadLinker = Facet.define<UploadLinker | null, UploadLinker | null>({ combine: (v) => v[0] ?? null });

/** Look again: the upload folders' contents changed. */
export const refreshUploadRefs = StateEffect.define<null>();

const SCAN = 64 * 1024;
const GLYPH = { image: "image", video: "film", audio: "music", file: "file" } as const;

class UploadRefWidget extends WidgetType {
  constructor(readonly link: UploadLink) {
    super();
  }
  eq(other: UploadRefWidget) {
    return other.link.path === this.link.path && other.link.kind === this.link.kind;
  }
  toDOM(view: EditorView) {
    const linker = view.state.facet(uploadLinker);
    const btn = document.createElement("span");
    btn.className = "cm-upload-ref";
    btn.setAttribute("role", "button");
    btn.setAttribute("aria-label", `Go to ${this.link.name}`);
    btn.appendChild(icon(GLYPH[this.link.kind], 12));
    btn.addEventListener("mouseenter", () => linker?.hover(btn, this.link));
    btn.addEventListener("mouseleave", () => linker?.leave());
    // Keep the caret where it is: this is a button, not text.
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      linker?.leave();
      linker?.open(this.link);
    });
    return btn;
  }
  ignoreEvent() {
    return true;
  }
}

function build(state: EditorState): DecorationSet {
  const linker = state.facet(uploadLinker);
  if (!linker) return Decoration.none;
  const head = state.sliceDoc(0, Math.min(state.doc.length, SCAN));
  const found = findFrontmatter(head);
  if (!found) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const first = state.doc.lineAt(found.rawStart).number;
  const last = state.doc.lineAt(Math.max(found.rawStart, found.rawEnd - 1)).number;
  if (found.rawEnd <= found.rawStart) return Decoration.none;
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n);
    for (const c of fileCandidates(line.text)) {
      const link = linker.find(c.text);
      if (link) builder.add(line.from + c.to, line.from + c.to, Decoration.widget({ widget: new UploadRefWidget(link), side: 1 }));
    }
  }
  return builder.finish();
}

export function uploadRefs(): Extension {
  return StateField.define<DecorationSet>({
    create: build,
    update(value, tr) {
      const refresh = tr.effects.some((e) => e.is(refreshUploadRefs));
      if (refresh || tr.startState.facet(uploadLinker) !== tr.state.facet(uploadLinker)) return build(tr.state);
      // Only edits inside the frontmatter can change what it names.
      if (tr.docChanged) {
        const fmEnd = findFrontmatter(tr.state.sliceDoc(0, Math.min(tr.state.doc.length, SCAN)))?.end ?? 0;
        let touched = false;
        tr.changes.iterChangedRanges((_a, _b, from) => {
          if (from <= fmEnd) touched = true;
        });
        return touched ? build(tr.state) : value.map(tr.changes);
      }
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}
