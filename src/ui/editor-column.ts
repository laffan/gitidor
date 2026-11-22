// Column 3: the open file, the preview toggle above it, and a footer with the
// word count and where the post is published.

import { h, iconButton } from "../lib/dom";
import { emit, knownFile, on, repoById, store } from "../lib/store";
import * as actions from "../lib/actions";
import { api, openExternal } from "../lib/ipc";
import { body } from "../lib/frontmatter";
import { imageDirectory, imageReference, publicAddress } from "../lib/site";
import { createEditor, type EditorAppearance, type EditorHandle } from "../editor/editor";
import { previewPane } from "./preview";
import { assetUrl } from "./asset-url";
import { resizeHandle } from "./resize";
import { log } from "../lib/log";
import { locate } from "../lib/locate";

let editor: EditorHandle | null = null;
export const getEditor = () => editor;

export function editorColumn(): HTMLElement {
  const title = h("div", { class: "doc-title", "data-tauri-drag-region": "" });
  const saveState = h("span", { class: "save-state", "aria-live": "polite" });
  const previewBtn = iconButton("eye", "Preview (⇧⌘P)", () => togglePreview());
  const sidebarBtn = iconButton("sidebar", "Show or hide the side columns (⌘\\)", () => toggleColumns(), { class: "icon-btn not-phone" });
  const backBtn = iconButton("back", "Files", () => actions.setLayout({ pane: "files" }), { class: "icon-btn only-phone" });
  const host = h("div", { class: "editor-host" });
  const empty = h(
    "div",
    { class: "editor-empty" },
    h("div", null, h("div", { class: "big" }, "Choose a post"), "or make a new one from a folder's menu.", h("div", { style: "margin-top:14px" }, h("span", { class: "kbd" }, "⌘N"), " new post   ", h("span", { class: "kbd" }, "⌘\\"), " columns   ", h("span", { class: "kbd" }, "⇧⌘P"), " preview")),
  );
  // A click on the preview's text puts the caret on the same words here.
  const preview = previewPane((click) => {
    if (!editor || !store.openFile) return;
    const pos = locate(editor.view.state.doc.toString(), click);
    if (pos === null) log.debug("app", `No match in the text for the clicked words “${(click.before.slice(-30) + click.after.slice(0, 30)).trim()}”`);
    else editor.revealAt(pos);
  });
  preview.el.appendChild(resizeHandle("preview"));
  const split = h("div", { class: "editor-split" }, host, preview.el);
  const words = h("span");
  const where = h("span");
  const foot = h("div", { class: "editor-foot" }, words, where);

  const appearance = (): EditorAppearance => ({
    spellcheck: store.settings.appearance.spellcheck,
    frontmatter: store.settings.appearance.frontmatter,
    inlineImages: store.settings.appearance.inlineImages,
  });
  editor = createEditor(host, (text) => {
    actions.editText(text);
    countWords();
  }, appearance());
  host.appendChild(empty);
  // For the browser harness in development; never in a build.
  if (import.meta.env.DEV) (window as unknown as { __gitidorEditor: EditorHandle }).__gitidorEditor = editor;

  let loadedKey = "";
  function load() {
    const f = store.openFile;
    const key = f ? `${f.repoId}:${f.path}` : "";
    empty.hidden = !!f;
    editor!.view.dom.hidden = !f;
    if (!f) {
      loadedKey = "";
      title.replaceChildren();
      words.textContent = "";
      where.replaceChildren();
      return;
    }
    const repo = repoById(f.repoId);
    if (key !== loadedKey) {
      loadedKey = key;
      editor!.load({
        text: f.text,
        resolveImage: repo ? (src) => assetUrl(repo, f.path, src) : null,
        importImage: repo ? (file) => importImage(repo.id, f.path, file) : null,
      });
      requestAnimationFrame(() => editor!.focus());
    } else if (editor!.view.state.doc.toString() !== f.text) {
      editor!.replaceText(f.text);
    }
    const name = f.path.split("/").pop() ?? f.path;
    const folder = f.path.slice(0, -name.length - 1);
    title.replaceChildren(...(folder ? [h("span", null, `${folder} / `)] : []), h("b", null, name));
    title.title = f.path;
    countWords();
    drawWhere();
  }

  function drawWhere() {
    const f = store.openFile;
    const repo = f && repoById(f.repoId);
    const entry = f && knownFile(f.repoId, f.path);
    where.replaceChildren();
    if (repo && entry?.url) {
      const url = publicAddress(repo, entry.url);
      if (url) where.append(h("a", { href: "#", class: "link", style: "color:inherit", title: "Open the published page", onclick: (e: Event) => (e.preventDefault(), void openExternal(url)) }, url.replace(/^https?:\/\//, "")));
    }
  }

  function countWords() {
    const f = store.openFile;
    if (!f) return;
    const text = body(f.text);
    const n = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
    words.textContent = `${n.toLocaleString()} word${n === 1 ? "" : "s"} · ${Math.max(1, Math.round(n / 230))} min read`;
  }

  function drawSave() {
    const f = store.openFile;
    saveState.classList.toggle("error", f?.state === "error");
    saveState.textContent = !f ? "" : f.state === "saving" ? "Saving…" : f.state === "editing" ? "Edited" : f.state === "error" ? "Not saved" : "Saved";
    saveState.title = f?.error ?? "";
  }

  on("file", load);
  on("save", drawSave);
  on("files", drawWhere);
  on("preview", () => previewBtn.classList.toggle("on", store.preview.open));
  on("settings", () => editor?.setAppearance(appearance()));
  load();
  drawSave();

  return h(
    "section",
    { class: "column col-editor", "aria-label": "Editor" },
    h("div", { class: "editor-bar", "data-tauri-drag-region": "" }, backBtn, sidebarBtn, title, saveState, previewBtn),
    split,
    foot,
  );
}

/** Show or hide the preview. It opens on the live site, or on the draft
 *  when the repository has no public address to show. */
export function togglePreview() {
  const f = store.openFile;
  if (!f) return;
  store.preview.open = !store.preview.open;
  if (store.preview.open) store.preview.mode = repoById(f.repoId)?.publicUrl ? "live" : "draft";
  emit("preview");
}

/** What ⌘\ hid, so showing the columns again brings back those, not both. */
let hiddenColumns: { repos: boolean; files: boolean } | null = null;

export function toggleColumns() {
  if (store.layout.repos || store.layout.files) {
    hiddenColumns = { repos: store.layout.repos, files: store.layout.files };
    actions.setLayout({ repos: false, files: false });
  } else {
    actions.setLayout(hiddenColumns ?? { repos: false, files: true });
    hiddenColumns = null;
  }
}

async function importImage(repoId: string, postPath: string, file: File): Promise<string> {
  const repo = repoById(repoId);
  const folder = postPath.split("/").slice(0, -1).join("/");
  const { dir } = imageDirectory(repo?.site ?? null, folder);
  const data = await actions.readBase64(file);
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
  const name = file.name && file.name !== "image.png" ? file.name : `image-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${ext}`;
  const saved = await api.importAsset(repoId, dir, name, data);
  log.info("files", `Saved image ${saved} (${(file.size / 1024).toFixed(0)} KB)`, repoId);
  void actions.refreshStatus(repoId);
  const ref = imageReference(repo?.site ?? null, postPath, saved);
  const alt = name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
  return `![${alt}](${ref.includes(" ") ? `<${ref}>` : ref})`;
}

