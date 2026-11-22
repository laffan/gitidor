// The editor's keyboard shortcuts: every text-editing binding from hush, with
// hush's default keys, plus the few gitidor adds. One list, used for both the
// CodeMirror keymap and the Shortcuts page in Settings, so the two cannot
// disagree.

import type { EditorView, KeyBinding } from "@codemirror/view";
import { findNext, findPrevious, openSearchPanel } from "@codemirror/search";
import {
  reduceSentenceSelection,
  shiftSelectionToNextSentence,
  shiftSelectionToPreviousSentence,
  moveSentenceForward,
  moveSentenceBack,
  deleteToSentenceEnd,
  jumpToNextSentence,
  jumpToPrevSentence,
  jumpToPrevParagraph,
  jumpToNextParagraph,
  selectParagraph,
  selectToParagraphAbove,
  selectToParagraphBelow,
  insertBreakAfter,
  insertBreakBefore,
} from "./hush/sentence-navigator.js";
import { selectSentenceOrSpan } from "./hush/sentence-parenthetical.js";
import { deleteSentence, deleteToSentenceStart } from "./hush/sentence-delete.js";
import { joinLines, joinLinesUp } from "./hush/join-lines.js";
import { toggleBold, toggleItalic, toggleHighlight, toggleComment, toggleStrikethrough, toggleBlockquote } from "./hush/formatting.js";
import { selectNextInstance, selectPreviousInstance } from "./hush/select-instance.js";
import { moveLineKeymap } from "./hush/move-line.js";

type Run = (view: EditorView) => boolean;

export interface Shortcut {
  key: string;
  label: string;
  group: "Selection" | "Movement" | "Editing" | "Formatting" | "Find" | "App";
  run?: Run;
  /** Bound by CodeMirror's own keymaps; listed here for the Shortcuts page. */
  builtin?: boolean;
}

/** Hush's `shortcut*` defaults, as CodeMirror key names. */
export const HUSH_SHORTCUTS: Shortcut[] = [
  { key: "Mod-l", label: "Select sentence (again to extend)", group: "Selection", run: selectSentenceOrSpan },
  { key: "Mod-Shift-l", label: "Reduce sentence selection", group: "Selection", run: reduceSentenceSelection },
  { key: "Alt-Shift-l", label: "Select paragraph", group: "Selection", run: selectParagraph },
  { key: "Mod-Shift-ArrowUp", label: "Extend selection to paragraph above", group: "Selection", run: selectToParagraphAbove },
  { key: "Mod-Shift-ArrowDown", label: "Extend selection to paragraph below", group: "Selection", run: selectToParagraphBelow },
  { key: "Mod-d", label: "Select next instance", group: "Selection", run: selectNextInstance },
  { key: "Mod-Shift-d", label: "Select previous instance", group: "Selection", run: selectPreviousInstance },
  { key: "Mod-Shift-ArrowRight", label: "Shift selection to next sentence", group: "Selection", run: shiftSelectionToNextSentence },
  { key: "Mod-Shift-ArrowLeft", label: "Shift selection to previous sentence", group: "Selection", run: shiftSelectionToPreviousSentence },

  { key: "Mod-ArrowRight", label: "Next sentence", group: "Movement", run: jumpToNextSentence },
  { key: "Mod-ArrowLeft", label: "Previous sentence", group: "Movement", run: jumpToPrevSentence },
  { key: "Mod-ArrowDown", label: "Next paragraph", group: "Movement", run: jumpToNextParagraph },
  { key: "Mod-ArrowUp", label: "Previous paragraph", group: "Movement", run: jumpToPrevParagraph },

  { key: "Alt-Mod-ArrowRight", label: "Move sentence forward", group: "Editing", run: moveSentenceForward },
  { key: "Alt-Mod-ArrowLeft", label: "Move sentence back", group: "Editing", run: moveSentenceBack },
  { key: "Alt-Shift-Backspace", label: "Delete to end of sentence", group: "Editing", run: deleteToSentenceEnd },
  { key: "Mod-Shift-Backspace", label: "Delete to start of sentence", group: "Editing", run: deleteToSentenceStart },
  { key: "Mod-Backspace", label: "Delete sentence", group: "Editing", run: deleteSentence },
  { key: "Mod-j", label: "Join with line below", group: "Editing", run: joinLines },
  { key: "Mod-Shift-j", label: "Join with line above", group: "Editing", run: joinLinesUp },
  { key: "Mod-Enter", label: "New line after", group: "Editing", run: (v) => (v.hasFocus ? insertBreakAfter(v) : false) },
  { key: "Mod-Shift-Enter", label: "New line before", group: "Editing", run: (v) => (v.hasFocus ? insertBreakBefore(v) : false) },
  { key: "Alt-ArrowUp", label: "Move line up", group: "Editing", run: moveLineKeymap[0].run },
  { key: "Alt-ArrowDown", label: "Move line down", group: "Editing", run: moveLineKeymap[1].run },

  { key: "Mod-b", label: "Bold", group: "Formatting", run: toggleBold },
  { key: "Mod-i", label: "Italic", group: "Formatting", run: toggleItalic },
  { key: "Mod-=", label: "Highlight (==text==)", group: "Formatting", run: toggleHighlight },
  { key: "Mod--", label: "Strikethrough", group: "Formatting", run: toggleStrikethrough },
  { key: "Mod-.", label: "Blockquote", group: "Formatting", run: toggleBlockquote },
  { key: "Mod-/", label: "Comment (%%text%%)", group: "Formatting", run: toggleComment },

  { key: "Mod-f", label: "Find", group: "Find", run: openSearchPanel },
  { key: "Mod-g", label: "Find next", group: "Find", run: findNext },
  { key: "Mod-Shift-g", label: "Find previous", group: "Find", run: findPrevious },
  { key: "Alt-click", label: "Add a cursor", group: "Selection", builtin: true },
  { key: "Escape", label: "Back to one cursor", group: "Selection", builtin: true },
  { key: "Mod-z", label: "Undo", group: "Editing", builtin: true },
  { key: "Mod-Shift-z", label: "Redo", group: "Editing", builtin: true },
];

/** gitidor's own, handled by the window rather than the editor. */
export const APP_SHORTCUTS: Shortcut[] = [
  { key: "Mod-s", label: "Save now (autosave also runs)", group: "App" },
  { key: "Mod-Shift-p", label: "Toggle preview", group: "App" },
  { key: "Mod-\\", label: "Show or hide the side columns", group: "App" },
  { key: "Mod-Shift-k", label: "Commit…", group: "App" },
  { key: "Mod-,", label: "Settings", group: "App" },
  { key: "Mod-n", label: "New post in the first folder", group: "App" },
];

export function editorKeymap(): KeyBinding[] {
  return HUSH_SHORTCUTS.filter((s) => s.run).map((s) => ({ key: s.key, run: s.run!, preventDefault: true }));
}
