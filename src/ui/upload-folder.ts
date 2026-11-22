// An upload folder in the Files column: every file in it, as thumbnails (the
// default) or a list, with a + beside the folder's menu that picks files and
// copies them in. Files can also be dropped on the folder. Clicking a picture,
// video or sound shows it in the editor column (media-view.ts); clicking
// anything else, or right-clicking, opens its menu (upload-menu.ts).
// Dragging one into the editor inserts its markdown.

import { h, icon, iconButton } from "../lib/dom";
import { emit, folderKey, store } from "../lib/store";
import * as actions from "../lib/actions";
import type { RepoRecord, UploadEntry } from "../lib/types";
import { assetUrl } from "./asset-url";
import { openMenu } from "./menu";
import { confirmModal } from "./modal";
import { markdownFor, mediaKind, uploadMenu } from "./upload-menu";
const VIEW_KEY = "gitidor.uploadViews";
const PAGE = 300;

type View = "icons" | "list";

let views: Record<string, View> = {};
try {
  views = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "{}") ?? {};
} catch {
  views = {};
}

const viewOf = (key: string): View => views[key] ?? "icons";

function setView(key: string, view: View) {
  views[key] = view;
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(views));
  } catch {
    /* a private window: the view is just not remembered */
  }
  emit("files");
}

/** How many of each folder's files are drawn; "Show all" lifts it. */
const shownCount = new Map<string, number>();

/**
 * Tiles are kept between redraws. The Files column redraws on every save
 * (the change dots move), and a new <img> would read the file from disk
 * again each time.
 */
const tiles = new Map<string, HTMLElement>();

function thumb(repo: RepoRecord, f: UploadEntry, size: number): HTMLElement {
  const kind = mediaKind(f.name);
  if (kind === "image") {
    const url = assetUrl(repo, "", `/${f.path}`, true);
    if (url) return h("span", { class: "thumb" }, h("img", { src: url, alt: "", loading: "lazy", decoding: "async", draggable: false }));
  }
  const ext = /\.([^.]+)$/.exec(f.name)?.[1] ?? "";
  const glyph = kind === "video" ? "film" : kind === "audio" ? "music" : "file";
  return h("span", { class: "thumb" }, h("span", { class: "doc" }, icon(glyph, size), ext ? h("span", { class: "ext" }, ext.slice(0, 5)) : null));
}

function item(repo: RepoRecord, folder: string, f: UploadEntry, view: View): HTMLElement {
  const key = `${repo.id}:${f.path}:${f.modified}:${f.size}:${f.change}:${view}`;
  const viewing = store.viewing?.repoId === repo.id && store.viewing.path === f.path;
  const cached = tiles.get(key);
  if (cached) {
    cached.classList.toggle("active", viewing);
    return cached;
  }
  const within = f.path.slice(folder.length + 1);
  const where = within !== f.name ? within.slice(0, -f.name.length - 1) : "";
  const dot = f.change ? h("span", { class: `dot ${f.change}`, title: f.change }) : null;
  const el =
    view === "icons"
      ? h("button", { class: "upload-tile", type: "button" }, thumb(repo, f, 26), h("span", { class: "name" }, f.name), dot)
      : h(
          "button",
          { class: "upload-row", type: "button" },
          thumb(repo, f, 16),
          h("span", { class: "text" }, h("span", { class: "name" }, f.name), h("span", { class: "sub" }, [actions.size(f.size), where].filter(Boolean).join(" · "))),
          dot,
        );
  el.title = `${f.path}\n${actions.size(f.size)}`;
  el.dataset.path = f.path;
  el.draggable = true;
  el.addEventListener("dragstart", (e) => {
    e.dataTransfer?.setData("text/plain", markdownFor(repo, f));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
  });
  // Pictures, video and sound open in the editor column; anything else
  // (a PDF, a zip) offers its menu. The menu is also a right-click away.
  el.addEventListener("click", () => {
    if (mediaKind(f.name)) actions.viewUpload(repo.id, folder, f.path);
    else uploadMenu(el, repo, folder, f);
  });
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    uploadMenu(el, repo, folder, f, { preview: true });
  });
  el.classList.toggle("active", viewing);
  tiles.set(key, el);
  return el;
}

/**
 * Bring a file into view in the Files column: its folder opened, every file
 * drawn, scrolled to and briefly marked. `showColumn` opens the Files column
 * if it is hidden.
 */
export function revealUpload(repoId: string, folder: string, path: string, showColumn = false) {
  const key = folderKey(repoId, folder);
  store.collapsed.delete(key);
  shownCount.set(key, Number.MAX_SAFE_INTEGER);
  if (showColumn && !store.layout.files) actions.setLayout({ files: true });
  emit("files");
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(`.upload-folder [data-path="${CSS.escape(path)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1400);
  });
}

export function uploadSection(repo: RepoRecord, folder: string): HTMLElement {
  const key = folderKey(repo.id, folder);
  const files = store.uploads[key];
  const q = store.filter.trim().toLowerCase();
  const shown = (files ?? []).filter((f) => !q || f.path.toLowerCase().includes(q));
  const collapsed = store.collapsed.has(key) && !q;
  const view = viewOf(key);
  const limit = shownCount.get(key) ?? PAGE;
  const busy = store.uploading[key];

  const picker = h("input", { type: "file", multiple: true, hidden: true });
  picker.addEventListener("change", () => {
    const chosen = [...(picker.files ?? [])];
    picker.value = "";
    void actions.uploadFiles(repo.id, folder, chosen);
  });

  const menuBtn = iconButton("menu", `${folder} options`, (e) => {
    openMenu(
      e.currentTarget as HTMLElement,
      [
        { label: "Upload files…", icon: "plus", run: () => picker.click() },
        { separator: true },
        { label: "View as icons", icon: "image", checked: view === "icons", run: () => setView(key, "icons") },
        { label: "View as list", icon: "menu", checked: view === "list", run: () => setView(key, "list") },
        { separator: true },
        { label: "Refresh", icon: "refresh", run: () => void actions.loadUploads(repo.id, folder).then(() => actions.refreshStatus(repo.id)) },
        {
          label: "Remove from list",
          icon: "x",
          danger: true,
          run: async () => {
            if (await confirmModal(`Remove ${folder}?`, "It leaves the Files column; nothing in the repository is deleted. You can add it again any time.", "Remove")) {
              await actions.removeUploadFolder(repo.id, folder);
            }
          },
        },
      ],
      "right",
    );
  });

  const body =
    files === undefined
      ? h("div", { class: "empty" }, h("span", { class: "spinner" }))
      : !shown.length
        ? h("div", { class: "empty" }, q ? "No matches." : "No files yet. Use + or drop files here to upload them.")
        : h("div", { class: view === "icons" ? "upload-grid" : "upload-list" }, shown.slice(0, limit).map((f) => item(repo, folder, f, view)));

  const section = h(
    "div",
    { class: `folder upload-folder ${collapsed ? "collapsed" : ""}` },
    h(
      "div",
      { class: "folder-head" },
      h(
        "button",
        {
          class: "label",
          type: "button",
          title: `${folder} (upload folder)`,
          onclick: () => {
            if (store.collapsed.has(key)) store.collapsed.delete(key);
            else store.collapsed.add(key);
            emit("files");
          },
        },
        h("span", { class: "chev" }, icon("chevron", 13)),
        h("span", { style: "overflow:hidden;text-overflow:ellipsis" }, folder),
        h("span", { class: "count" }, files ? String(files.length) : ""),
      ),
      iconButton("plus", `Upload files to ${folder}`, () => picker.click(), { disabled: !!busy }),
      menuBtn,
      picker,
    ),
    busy ? h("div", { class: "upload-status" }, h("span", { class: "spinner" }), busy) : null,
    h(
      "div",
      { class: "file-list" },
      body,
      shown.length > limit
        ? h(
            "button",
            {
              class: "link show-all",
              type: "button",
              onclick: () => {
                shownCount.set(key, shown.length);
                emit("files");
              },
            },
            `Show all ${shown.length}`,
          )
        : null,
    ),
  );

  // Files dragged in from elsewhere upload here.
  const isFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  section.addEventListener("dragover", (e) => {
    if (!isFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    section.classList.add("drop-target");
  });
  section.addEventListener("dragleave", (e) => {
    if (!section.contains(e.relatedTarget as Node | null)) section.classList.remove("drop-target");
  });
  section.addEventListener("drop", (e) => {
    if (!isFiles(e)) return;
    e.preventDefault();
    section.classList.remove("drop-target");
    void actions.uploadFiles(repo.id, folder, [...(e.dataTransfer?.files ?? [])]);
  });
  return section;
}
