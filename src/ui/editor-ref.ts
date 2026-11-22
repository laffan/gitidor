// The editor, for the parts of the interface that put text into it (an
// upload's "Insert into post") without importing the editor column itself.

import type { EditorHandle } from "../editor/editor";

let current: EditorHandle | null = null;

export const setEditor = (editor: EditorHandle | null) => (current = editor);
export const getEditor = () => current;
