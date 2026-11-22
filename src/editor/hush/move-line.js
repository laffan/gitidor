/**
 * Option-↑ / Option-↓ — move the caret's line (or every line the
 * selection touches) up or down past its neighbour, as in a code editor.
 *
 * In hush (src/editor/move-line.js) this steps over cards; gitidor has
 * none, so it is CodeMirror's own command under hush's binding. Shift-
 * Option-↑ / ↓ (copy line) stay unbound, as in hush: in prose they mostly
 * duplicated a line by accident.
 */
import { moveLineUp, moveLineDown } from "@codemirror/commands";

export const moveLineKeymap = [
  { key: "Alt-ArrowUp", run: moveLineUp },
  { key: "Alt-ArrowDown", run: moveLineDown },
];
