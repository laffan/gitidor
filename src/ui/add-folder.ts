// The Add Folder sheet: the clone's directories, the site profile's guesses
// marked, the ones already added greyed out. A switch at the top chooses the
// kind: a content folder (posts, listed by title; folders counted by their
// markdown) or an upload folder (any files, shown as thumbnails, that files
// can be uploaded into; folders counted by their files).

import { h, icon } from "../lib/dom";
import { api } from "../lib/ipc";
import { repoById } from "../lib/store";
import * as actions from "../lib/actions";
import type { DirInfo } from "../lib/types";
import { openModal } from "./modal";

type Kind = "content" | "upload";

export async function openAddFolder(repoId: string, opts: { firstTime?: boolean; kind?: Kind } = {}) {
  const repo = repoById(repoId);
  if (!repo) return;
  let kind: Kind = opts.kind ?? "content";
  const m = openModal({ title: opts.firstTime ? `Which folders hold ${repo.name}'s posts?` : "Add Folder", width: 520 });
  const list = h("div", { class: "dir-tree" }, h("div", { class: "empty" }, h("span", { class: "spinner" })));
  const filter = h("input", { class: "input search", placeholder: "Filter folders", style: "margin-bottom:8px" });
  const showAll = h("input", { type: "checkbox", class: "switch" });
  const showAllLabel = h("span");
  const addBtn = h("button", { class: "btn primary", type: "button", disabled: true }, "Add");
  const chosen = new Set<string>();
  const existing = new Set([...repo.folders, ...(repo.uploadFolders ?? [])]);

  const contentTab = h("button", { type: "button", role: "radio" }, "Content folder");
  const uploadTab = h("button", { type: "button", role: "radio" }, "Upload folder");
  const kindHint = h("div", { class: "hint", style: "margin:6px 0 12px" });
  const kindSwitch = h("div", { class: "field", style: "margin-bottom:6px" }, h("div", { class: "segmented", role: "radiogroup", "aria-label": "Kind of folder" }, contentTab, uploadTab), kindHint);
  contentTab.addEventListener("click", () => setKind("content"));
  uploadTab.addEventListener("click", () => setKind("upload"));

  m.body.append(
    ...[
      opts.firstTime
        ? h(
            "p",
            { style: "margin:0 0 12px;color:var(--text-2);line-height:1.5" },
            repo.site && repo.site.generator !== "unknown"
              ? `This looks like ${/^[aeiou]/i.test(label(repo.site.generator)) ? "an" : "a"} ${label(repo.site.generator)} site. The folders it publishes posts from are marked; choose any you want to edit.`
              : "Choose the folders you want to edit. Most sites keep posts in one.",
          )
        : kindSwitch,
    ],
    filter,
    list,
    h("label", { class: "row", style: "margin-top:10px;color:var(--text-2);gap:8px" }, showAll, showAllLabel),
  );
  m.foot.append(h("button", { class: "btn quiet", type: "button", onclick: () => m.close() }, opts.firstTime ? "Later" : "Cancel"), addBtn);

  /** What the site profile says holds posts, or (for uploads) the files its pages use. */
  const suggestions = (): Set<string> =>
    new Set(
      kind === "content"
        ? (repo.site?.suggestedFolders ?? [])
        : (repo.site?.assets ?? []).map((a) => a.repoPath.replace(/\/+$/, "")).filter((p) => p && dirs.some((d) => d.path === p)),
    );
  const hasFiles = (d: DirInfo) => (kind === "content" ? d.markdownTotal > 0 : d.filesTotal > 0);
  const counts = (d: DirInfo) =>
    kind === "content"
      ? d.markdown
        ? `${d.markdown} md`
        : d.markdownTotal
          ? `${d.markdownTotal} below`
          : ""
      : d.files
        ? `${d.files} file${d.files === 1 ? "" : "s"}`
        : d.filesTotal
          ? `${d.filesTotal} below`
          : "";

  let dirs: DirInfo[] = [];

  function setKind(next: Kind) {
    kind = next;
    chosen.clear();
    contentTab.classList.toggle("on", kind === "content");
    uploadTab.classList.toggle("on", kind === "upload");
    contentTab.setAttribute("aria-checked", String(kind === "content"));
    uploadTab.setAttribute("aria-checked", String(kind === "upload"));
    kindHint.textContent =
      kind === "content"
        ? "Markdown posts, listed by title, newest first."
        : "Images and other files, shown as thumbnails. Files you upload are copied into it; commit and push to put them on the site.";
    showAllLabel.textContent = kind === "content" ? "Show folders without markdown" : "Show empty folders";
    draw();
    sync();
  }

  const draw = () => {
    if (!dirs.length) return;
    const suggested = suggestions();
    const q = filter.value.toLowerCase();
    const rows = dirs
      .filter((d) => showAll.checked || hasFiles(d) || existing.has(d.path))
      .filter((d) => !q || d.path.toLowerCase().includes(q))
      .sort((a, b) => Number(suggested.has(b.path)) - Number(suggested.has(a.path)) || a.path.localeCompare(b.path))
      .slice(0, 400);
    list.replaceChildren(
      ...rows.map((d) => {
        const added = existing.has(d.path);
        const box = h("input", { type: "checkbox", checked: added || chosen.has(d.path), disabled: added });
        const row = h(
          "label",
          { class: `dir-row ${suggested.has(d.path) && !added ? "suggested" : ""} ${added ? "added" : ""}`, style: `padding-left:${10 + (q ? 0 : Math.min(d.depth - 1, 5) * 14)}px` },
          box,
          icon(kind === "upload" ? "image" : "folder", 15),
          h("span", { class: "name" }, q ? d.path : (d.path.split("/").pop() ?? d.path)),
          h("span", { class: "n" }, added ? (repo.folders.includes(d.path) ? "added" : "added for uploads") : counts(d)),
        );
        box.addEventListener("change", () => {
          if (box.checked) chosen.add(d.path);
          else chosen.delete(d.path);
          sync();
        });
        return row;
      }),
    );
    if (!rows.length)
      list.append(
        h("div", { class: "empty" }, kind === "content" ? "No folders with markdown files. Turn on “Show folders without markdown” to choose another." : "No folders with files in them. Turn on “Show empty folders” to choose another."),
      );
  };
  const sync = () => {
    addBtn.disabled = chosen.size === 0;
    const what = kind === "upload" ? "upload folder" : "folder";
    addBtn.textContent = chosen.size > 1 ? `Add ${chosen.size} ${what}s` : `Add ${what}`;
  };
  addBtn.addEventListener("click", async () => {
    m.setBusy(true);
    try {
      if (kind === "content") await actions.setFolders(repoId, [...repo.folders, ...chosen]);
      else await actions.setUploadFolders(repoId, [...(repo.uploadFolders ?? []), ...chosen]);
      m.close();
    } catch (e) {
      m.setBusy(false);
      m.body.append(h("div", { class: "notice error", style: "margin-top:10px" }, (e as Error).message));
    }
  });
  filter.addEventListener("input", draw);
  showAll.addEventListener("change", draw);
  setKind(kind);

  try {
    dirs = await api.listDirs(repoId);
  } catch (e) {
    list.replaceChildren(h("div", { class: "notice error" }, (e as Error).message));
    return;
  }
  if (opts.firstTime)
    for (const s of suggestions())
      if (!existing.has(s) && dirs.some((d) => d.path === s)) {
        chosen.add(s);
        break; // Just the most likely one; the rest are a tap away.
      }
  draw();
  sync();
}

function label(generator: string): string {
  return ({ eleventy: "Eleventy", jekyll: "Jekyll", hugo: "Hugo", astro: "Astro" } as Record<string, string>)[generator] ?? generator;
}
