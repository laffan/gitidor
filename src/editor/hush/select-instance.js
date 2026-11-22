// Ported from hush (github.com/laffan/hush @ df4a07f), src/editor/commands.js:
// ⌘D / ⌘⇧D, which step the selection to the next or previous instance of
// the selected text and keep every instance faintly marked.
import { EditorSelection } from "@codemirror/state";
import { setInstanceHighlightsEffect, findAllOccurrences } from "./select-instance-highlight.js";

/** Multi-cursor "select next occurrence" — was inline in editor.js. */
export function selectNextInstance(view) {
  const sel = view.state.selection.main;
  if (sel.empty) {
    const line = view.state.doc.lineAt(sel.head);
    const text = line.text;
    const offset = sel.head - line.from;
    let start = offset;
    let end = offset;
    while (start > 0 && /\w/.test(text[start - 1])) start--;
    while (end < text.length && /\w/.test(text[end])) end++;
    if (start !== end) {
      const word = text.slice(start, end);
      view.dispatch({
        selection: { anchor: line.from + start, head: line.from + end },
        effects: setInstanceHighlightsEffect.of(findAllOccurrences(view.state.doc.toString(), word)),
      });
    }
    return true;
  }
  const selected = view.state.sliceDoc(sel.from, sel.to);
  const docText = view.state.doc.toString();
  const allRanges = view.state.selection.ranges;
  const lastRange = allRanges[allRanges.length - 1];
  const searchFrom = Math.max(lastRange.from, lastRange.to);
  let nextIdx = docText.indexOf(selected, searchFrom);
  if (nextIdx === -1) nextIdx = docText.indexOf(selected, 0);
  const alreadySelected = allRanges.some((r) => {
    const from = Math.min(r.anchor, r.head);
    return from === nextIdx;
  });
  if (nextIdx !== -1 && !alreadySelected) {
    // Steps to the instance rather than adding it: the selection was
    // always collapsed to that one range while the editor allowed only
    // one, and ⌥-click multi-cursor (multi-cursor.js) must not change
    // what ⌘D does.
    view.dispatch({
      selection: EditorSelection.single(nextIdx, nextIdx + selected.length),
      effects: setInstanceHighlightsEffect.of(findAllOccurrences(docText, selected)),
    });
  }
  return true;
}

/** Multi-cursor "select previous occurrence". */
export function selectPreviousInstance(view) {
  const sel = view.state.selection.main;
  if (sel.empty) return false;
  const selected = view.state.sliceDoc(sel.from, sel.to);
  const docText = view.state.doc.toString();
  const allRanges = view.state.selection.ranges;
  const firstRange = allRanges[0];
  const searchBefore = Math.min(firstRange.from, firstRange.to);
  let prevIdx = docText.lastIndexOf(selected, searchBefore - 1);
  if (prevIdx === -1) prevIdx = docText.lastIndexOf(selected);
  const alreadySelected = allRanges.some((r) => {
    const from = Math.min(r.anchor, r.head);
    return from === prevIdx;
  });
  if (prevIdx !== -1 && !alreadySelected) {
    // Steps, as selectNextInstance does.
    view.dispatch({
      selection: EditorSelection.single(prevIdx, prevIdx + selected.length),
      effects: setInstanceHighlightsEffect.of(findAllOccurrences(docText, selected)),
    });
  }
  return true;
}
