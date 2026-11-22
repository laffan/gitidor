// The text editor: CodeMirror 6 set up as hush sets it up for prose —
// markdown with highlight and comment syntax, hush's sentence and paragraph
// commands on hush's keys, ⌥-click multi-cursor, selection-wrapping brackets
// — plus what a site editor needs: frontmatter that stays frontmatter, and
// images found through the site profile.

import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, dropCursor, highlightSpecialChars, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { search, searchKeymap } from "@codemirror/search";
import { tags } from "@lezer/highlight";
import { CommentExtension, HighlightExtension, commentMarkTag, commentTag, highlightMarkTag, highlightTag } from "./hush/markdown-extensions.js";
import { instanceHighlightField } from "./hush/select-instance-highlight.js";
import { multiCursorExtension } from "./hush/multi-cursor.js";
import { wrapOnSelection } from "./hush/wrap-on-selection.js";
import { editorKeymap } from "./keymap";
import { FrontmatterBlock, frontmatterDecorations, frontmatterMode, type FrontmatterMode } from "./frontmatter-ext";
import { imageResolver, inlineImages, inlineImagesOn, type ImageResolver } from "./images";

const style = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "700" },
  { tag: tags.heading1, fontWeight: "700", fontSize: "1.18em" },
  { tag: tags.heading2, fontWeight: "700", fontSize: "1.08em" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through", opacity: "0.55" },
  { tag: tags.link, color: "var(--accent-text)" },
  { tag: tags.url, color: "var(--text-3)" },
  { tag: tags.monospace, fontFamily: "var(--mono-font)", fontSize: "0.92em", backgroundColor: "var(--bg-sunken)", borderRadius: "3px" },
  { tag: tags.quote, color: "var(--text-2)", fontStyle: "italic" },
  { tag: tags.processingInstruction, color: "var(--md-mark)" },
  { tag: tags.contentSeparator, color: "var(--md-mark)" },
  { tag: tags.labelName, color: "var(--text-3)" },
  { tag: [tags.angleBracket, tags.tagName, tags.attributeName], color: "var(--text-3)" },
  { tag: tags.attributeValue, color: "var(--text-2)" },
  { tag: highlightTag, backgroundColor: "var(--highlight)", borderRadius: "2px" },
  { tag: highlightMarkTag, color: "var(--md-mark)" },
  { tag: commentTag, color: "var(--text-3)" },
  { tag: commentMarkTag, color: "var(--md-mark)" },
]);

// CodeMirror's defaults, less the line-copy bindings hush leaves out (in
// prose they mostly duplicated a line by accident) and the bindings hush's
// own commands take over.
const DROPPED = new Set(["Alt-ArrowUp", "Alt-ArrowDown", "Shift-Alt-ArrowUp", "Shift-Alt-ArrowDown"]);
const baseKeymap = defaultKeymap.filter((b) => !b.key || !DROPPED.has(b.key));

// Layout rules that have to outrank CodeMirror's base theme (which sets
// `.cm-content { margin: 0 }`): scoped themes are mounted after it.
const layout = EditorView.theme({
  ".cm-content": {
    maxWidth: "calc(var(--column) + 64px)",
    width: "100%",
    margin: "0 auto",
    padding: "36px 32px 45vh",
    caretColor: "var(--accent)",
  },
  ".cm-scroller": { lineHeight: "var(--line-height)", fontFamily: "var(--editor-font)" },
});

export interface EditorAppearance {
  spellcheck: boolean;
  frontmatter: FrontmatterMode;
  inlineImages: boolean;
}

export interface EditorFile {
  text: string;
  resolveImage: ImageResolver | null;
  /** Save pasted or dropped image files; answers the markdown to insert. */
  importImage: ((file: File) => Promise<string>) | null;
}

export interface EditorHandle {
  view: EditorView;
  load(file: EditorFile): void;
  /** Replace the text without losing the caret or history, after a pull. */
  replaceText(text: string): void;
  setAppearance(a: EditorAppearance): void;
  focus(): void;
}

export function createEditor(host: HTMLElement, onChange: (text: string) => void, appearance: EditorAppearance): EditorHandle {
  const look = new Compartment();
  const fileConf = new Compartment();
  let current: EditorFile | null = null;
  let quiet = false;

  const lookExt = (a: EditorAppearance): Extension => [
    EditorView.contentAttributes.of({ spellcheck: a.spellcheck ? "true" : "false", autocorrect: a.spellcheck ? "on" : "off", autocapitalize: "sentences" }),
    frontmatterMode.of(a.frontmatter),
    inlineImagesOn.of(a.inlineImages),
  ];

  const pasteImages = (files: FileList | null | undefined, view: EditorView, at?: number): boolean => {
    const images = [...(files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!images.length || !current?.importImage) return false;
    const importer = current.importImage;
    void (async () => {
      for (const file of images) {
        try {
          const md = await importer(file);
          const pos = at ?? view.state.selection.main.head;
          view.dispatch({ changes: { from: pos, insert: md }, selection: { anchor: pos + md.length }, userEvent: "input.paste" });
        } catch (e) {
          console.error(e);
        }
      }
    })();
    return true;
  };

  const extensions = (): Extension => [
    history(),
    drawSelection(),
    dropCursor(),
    highlightSpecialChars(),
    multiCursorExtension(),
    EditorView.lineWrapping,
    layout,
    markdown({ base: markdownLanguage, extensions: [FrontmatterBlock, HighlightExtension, CommentExtension] }),
    syntaxHighlighting(style),
    search({ top: true }),
    instanceHighlightField,
    wrapOnSelection,
    frontmatterDecorations(),
    inlineImages(),
    Prec.highest(keymap.of(editorKeymap())),
    keymap.of([...baseKeymap, ...historyKeymap, ...searchKeymap]),
    placeholder("Start writing…"),
    look.of(lookExt(appearance)),
    fileConf.of(imageResolver.of(current?.resolveImage ?? null)),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && !quiet) onChange(u.state.doc.toString());
    }),
    EditorView.domEventHandlers({
      paste: (e, view) => {
        if (pasteImages(e.clipboardData?.files, view)) {
          e.preventDefault();
          return true;
        }
        return false;
      },
      drop: (e, view) => {
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? undefined;
        if (pasteImages(e.dataTransfer?.files, view, pos)) {
          e.preventDefault();
          return true;
        }
        return false;
      },
    }),
  ];

  const view = new EditorView({ parent: host, state: EditorState.create({ doc: "", extensions: extensions() }) });

  return {
    view,
    load(file) {
      current = file;
      view.setState(EditorState.create({ doc: file.text, extensions: extensions() }));
      view.scrollDOM.scrollTop = 0;
    },
    replaceText(text) {
      quiet = true;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      quiet = false;
    },
    setAppearance(a) {
      appearance = a;
      view.dispatch({ effects: look.reconfigure(lookExt(a)) });
    },
    focus() {
      view.focus();
    },
  };
}
