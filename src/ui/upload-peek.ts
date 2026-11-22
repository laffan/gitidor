// The buttons beside frontmatter values that name uploads: what they match,
// the small preview that shows while the pointer rests on one, and where a
// click goes — the file in the media viewer (pictures, video, sound) and, in
// any case, the file found and marked in its upload folder.

import { h, icon } from "../lib/dom";
import { folderKey, repoById, store } from "../lib/store";
import * as actions from "../lib/actions";
import { resolveAsset } from "../lib/site";
import { matchUpload } from "../lib/upload-refs";
import type { UploadEntry } from "../lib/types";
import type { UploadLink, UploadLinker } from "../editor/upload-refs-ext";
import { assetUrl } from "./asset-url";
import { mediaKind } from "./upload-menu";
import { revealUpload } from "./upload-folder";

/** Every listed upload in a repository, with the folder it was listed under. */
function uploadsOf(repoId: string): { folder: string; entry: UploadEntry }[] {
  const repo = repoById(repoId);
  const out: { folder: string; entry: UploadEntry }[] = [];
  for (const folder of repo?.uploadFolders ?? []) for (const entry of store.uploads[folderKey(repoId, folder)] ?? []) out.push({ folder, entry });
  return out;
}

let peek: HTMLElement | null = null;
let showTimer: ReturnType<typeof setTimeout> | undefined;

function hidePeek() {
  clearTimeout(showTimer);
  peek?.remove();
  peek = null;
}

function showPeek(anchor: HTMLElement, repoId: string, link: UploadLink) {
  hidePeek();
  const repo = repoById(repoId);
  const hit = uploadsOf(repoId).find((u) => u.entry.path === link.path);
  if (!repo || !hit) return;
  const { entry, folder } = hit;
  const kind = mediaKind(entry.name);
  const src = kind === "image" ? assetUrl(repo, "", `/${entry.path}`, true) : null;
  const picture = src
    ? h("img", { src, alt: "", draggable: false })
    : h("div", { class: "peek-glyph" }, icon(kind === "video" ? "film" : kind === "audio" ? "music" : "file", 34));
  const box = h(
    "div",
    { class: "upload-peek", role: "tooltip" },
    picture,
    h("div", { class: "peek-name" }, entry.name),
    h("div", { class: "peek-sub" }, [folder, actions.size(entry.size)].join(" · ")),
    h("div", { class: "peek-hint" }, kind ? "Click to open" : "Click to show in the Files column"),
  );
  document.body.appendChild(box);
  peek = box;
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const w = box.offsetWidth;
    const hgt = box.offsetHeight;
    let left = Math.min(r.left - 8, window.innerWidth - w - 8);
    left = Math.max(8, left);
    let top = r.bottom + 6;
    if (top + hgt > window.innerHeight - 8) top = Math.max(8, r.top - hgt - 6);
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
  };
  place();
  if (picture instanceof HTMLImageElement) picture.addEventListener("load", place);
}

/** Go to an upload: open it in the viewer if it is media, and find it in the Files column. */
export function goToUpload(repoId: string, path: string) {
  const hit = uploadsOf(repoId).find((u) => u.entry.path === path);
  if (!hit) return;
  if (mediaKind(hit.entry.name)) {
    actions.viewUpload(repoId, hit.folder, path);
    revealUpload(repoId, hit.folder, path);
  } else {
    actions.setLayout({ pane: "files" });
    revealUpload(repoId, hit.folder, path, true);
  }
}

/** What the editor needs for the open post `postPath` in repository `repoId`. */
export function uploadLinkerFor(repoId: string, postPath: string): UploadLinker {
  return {
    find(name) {
      const repo = repoById(repoId);
      if (!repo) return null;
      const all = uploadsOf(repoId);
      if (!all.length) return null;
      const entry = matchUpload(
        name,
        all.map((u) => u.entry),
        (ref) => {
          const r = resolveAsset(repo, postPath, ref);
          return r.kind === "local" ? r.path : null;
        },
      );
      return entry ? { path: entry.path, name: entry.name, kind: mediaKind(entry.name) ?? "file" } : null;
    },
    hover(anchor, link) {
      clearTimeout(showTimer);
      showTimer = setTimeout(() => showPeek(anchor, repoId, link), 180);
    },
    leave: hidePeek,
    open(link) {
      hidePeek();
      goToUpload(repoId, link.path);
    },
  };
}
