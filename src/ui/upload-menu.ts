// What can be done with a file in an upload folder, from its menu in the
// Files column or from the media viewer: put it in the open post, copy its
// markdown, discard its changes, delete it. And which files are pictures,
// video or sound, which the viewer shows.

import { store } from "../lib/store";
import * as actions from "../lib/actions";
import { imageReference } from "../lib/site";
import type { RepoRecord, UploadEntry } from "../lib/types";
import { getEditor } from "./editor-ref";
import { openMenu, type MenuItem } from "./menu";
import { confirmModal } from "./modal";
import { toast } from "./toast";

export type MediaKind = "image" | "video" | "audio";

// Formats WebKit (and so Safari, and this app) shows or plays.
const KINDS: [RegExp, MediaKind][] = [
  [/\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i, "image"],
  [/\.(mp4|m4v|mov|webm|ogv)$/i, "video"],
  [/\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i, "audio"],
];

export function mediaKind(name: string): MediaKind | null {
  return KINDS.find(([re]) => re.test(name))?.[1] ?? null;
}

/** The markdown that puts this file in the open post (or, with none open, at the site root). */
export function markdownFor(repo: RepoRecord, f: UploadEntry): string {
  const post = store.openFile?.repoId === repo.id ? store.openFile.path : "";
  const ref = imageReference(repo.site ?? null, post, f.path);
  const target = ref.includes(" ") ? `<${ref}>` : ref;
  const label = f.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
  return mediaKind(f.name) === "image" ? `![${label}](${target})` : `[${label}](${target})`;
}

/** At the caret in the open post, which must be in the same repository. */
export function insertIntoPost(repo: RepoRecord, f: UploadEntry) {
  const editor = getEditor();
  if (!editor || store.openFile?.repoId !== repo.id) return;
  const view = editor.view;
  const md = markdownFor(repo, f);
  const at = view.state.selection.main;
  view.dispatch({ changes: { from: at.from, to: at.to, insert: md }, selection: { anchor: at.from + md.length }, userEvent: "input.paste" });
  view.focus();
}

export function uploadMenuItems(repo: RepoRecord, folder: string, f: UploadEntry, opts: { heading?: boolean; preview?: boolean } = {}): MenuItem[] {
  const postOpen = store.openFile?.repoId === repo.id;
  return [
    ...(opts.heading === false ? [] : [{ heading: f.name }]),
    ...(opts.preview && mediaKind(f.name) ? [{ label: "Preview", icon: "eye", run: () => actions.viewUpload(repo.id, folder, f.path) }] : []),
    {
      label: "Insert into post",
      icon: "edit",
      disabled: !postOpen,
      title: postOpen ? undefined : "Open a post first",
      run: () => {
        actions.closeViewer();
        insertIntoPost(repo, f);
      },
    },
    {
      label: "Copy markdown",
      icon: "copy",
      run: () => {
        void navigator.clipboard?.writeText(markdownFor(repo, f)).then(
          () => toast("Copied."),
          () => toast("Could not reach the clipboard.", "error"),
        );
      },
    },
    ...(f.change
      ? [
          {
            label: "Discard changes…",
            icon: "undo",
            run: async () => {
              const what = f.change === "added" ? "This file is new; discarding deletes it." : "It goes back to how it was in the last commit.";
              if (await confirmModal(`Discard changes to ${f.name}?`, what, "Discard", true)) await actions.discard(repo.id, f.path);
            },
          },
        ]
      : []),
    { separator: true as const },
    {
      label: "Delete…",
      icon: "trash",
      danger: true,
      run: async () => {
        if (await confirmModal(`Delete ${f.name}?`, "The file is deleted here. Commit and push to remove it from the site too. Posts that use it will show it missing.", "Delete", true)) {
          await actions.deleteFile(repo.id, f.path, folder, "upload");
        }
      },
    },
  ];
}

export function uploadMenu(anchor: HTMLElement, repo: RepoRecord, folder: string, f: UploadEntry, opts: { preview?: boolean } = {}) {
  openMenu(anchor, uploadMenuItems(repo, folder, f, opts));
}
