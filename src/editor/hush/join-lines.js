/**
 * Join lines — ⌘J pulls the line below up onto the caret's line, ⌘⇧J
 * pulls the caret's line up onto the one above. The break and any
 * indentation it carried become one space (none when the pulled line is
 * blank).
 *
 * Ported from hush (src/editor/join-lines.js), less the part that steps
 * over hush's cards, which gitidor documents do not have.
 */
import { EditorSelection } from "@codemirror/state";

function join(view, upper, lower) {
  const leadingWs = lower.text.match(/^\s*/)[0].length;
  const insert = lower.text.trim().length > 0 ? " " : "";
  view.dispatch({
    changes: { from: upper.to, to: lower.from + leadingWs, insert },
    selection: EditorSelection.cursor(upper.to + insert.length),
    userEvent: "input.join",
  });
  return true;
}

/** Remove the next line break, joining the current line with the line below. */
export function joinLines(view) {
  const doc = view.state.doc;
  const line = doc.lineAt(view.state.selection.main.head);
  if (line.number >= doc.lines) return true;
  return join(view, line, doc.line(line.number + 1));
}

/** Remove the previous line break, joining the current line with the line above. */
export function joinLinesUp(view) {
  const doc = view.state.doc;
  const line = doc.lineAt(view.state.selection.main.head);
  if (line.number <= 1) return true;
  return join(view, doc.line(line.number - 1), line);
}
