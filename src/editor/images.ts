// Inline images: every image a line names — markdown `![alt](src)` or an HTML
// `<img src>` — drawn beneath that line, found through the repository's site
// profile (so `/images/blog/a.jpg` shows `public/blog-images/a.jpg`). The
// markdown itself stays as written and editable; the pictures are beside it.
//
// Block widgets have to come from a state field rather than a view plugin, so
// this rescans the document on each change. Posts are short enough that the
// scan is far below a frame.

import { Facet, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";

export type ImageResolver = (src: string) => string | null;

export const imageResolver = Facet.define<ImageResolver | null, ImageResolver | null>({
  combine: (v) => v[0] ?? null,
});

export const inlineImagesOn = Facet.define<boolean, boolean>({ combine: (v) => v[0] ?? true });

const MD_IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
const HTML_IMAGE = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;

export interface FoundImage {
  alt: string;
  src: string;
  from: number;
}

export function imagesInLine(text: string, offset = 0): FoundImage[] {
  const out: FoundImage[] = [];
  for (const m of text.matchAll(MD_IMAGE)) {
    // Eleventy sites like the one this was written for use `caption | class`.
    out.push({ alt: m[1].split("|")[0].trim(), src: m[2], from: offset + (m.index ?? 0) });
  }
  for (const m of text.matchAll(HTML_IMAGE)) {
    const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(m[0])?.[1] ?? "";
    out.push({ alt, src: m[1], from: offset + (m.index ?? 0) });
  }
  return out.sort((a, b) => a.from - b.from);
}

class ImagesWidget extends WidgetType {
  constructor(readonly images: { alt: string; src: string; url: string | null; from: number }[]) {
    super();
  }
  eq(other: ImagesWidget) {
    return other.images.length === this.images.length && other.images.every((im, i) => im.url === this.images[i].url && im.alt === this.images[i].alt);
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = `cm-images${this.images.length > 1 ? " many" : ""}`;
    for (const im of this.images) {
      const box = document.createElement("div");
      box.className = "cm-image";
      if (!im.url) {
        box.classList.add("broken");
        box.textContent = `Not found: ${im.src}`;
      } else {
        const img = document.createElement("img");
        img.src = im.url;
        img.alt = im.alt;
        img.loading = "lazy";
        img.decoding = "async";
        img.addEventListener("error", () => {
          box.classList.add("broken");
          box.textContent = `Not found in the repository: ${im.src}`;
          box.title = "Check the site structure in the repository's settings.";
        });
        img.addEventListener("load", () => view.requestMeasure());
        box.appendChild(img);
        if (im.alt) {
          const cap = document.createElement("div");
          cap.className = "cap";
          cap.textContent = im.alt;
          box.appendChild(cap);
        }
      }
      box.addEventListener("mousedown", (e) => {
        e.preventDefault();
        view.dispatch({ selection: { anchor: im.from + 2 }, scrollIntoView: true });
        view.focus();
      });
      wrap.appendChild(box);
    }
    return wrap;
  }
  get estimatedHeight() {
    return 220;
  }
  ignoreEvent() {
    return false;
  }
}

function build(state: EditorState): DecorationSet {
  if (!state.facet(inlineImagesOn)) return Decoration.none;
  const resolve = state.facet(imageResolver);
  if (!resolve) return Decoration.none;
  const ranges = [];
  const text = state.doc.toString();
  if (!text.includes("![") && !/<img/i.test(text)) return Decoration.none;
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (!line.text.includes("![") && !/<img/i.test(line.text)) continue;
    const found = imagesInLine(line.text, line.from);
    if (!found.length) continue;
    const images = found.map((f) => ({ ...f, url: resolve(f.src) }));
    ranges.push(Decoration.widget({ widget: new ImagesWidget(images), block: true, side: 1 }).range(line.to));
  }
  return Decoration.set(ranges);
}

export function inlineImages(): Extension {
  return StateField.define<DecorationSet>({
    create: build,
    update(value, tr) {
      if (tr.docChanged || tr.startState.facet(imageResolver) !== tr.state.facet(imageResolver) || tr.startState.facet(inlineImagesOn) !== tr.state.facet(inlineImagesOn)) {
        return build(tr.state);
      }
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}
