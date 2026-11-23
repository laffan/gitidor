// Column 2: the folders chosen for the active repository, each with its
// markdown files under it and a menu (new post, refresh, remove) across from
// its name; then the upload folders, as thumbnails (upload-folder.ts).
// "Add Folder" is always last. The head has the button that shows
// and hides the repositories column, the repository's name, a globe that
// shows the published site in the editor column (site-view.ts), and — when
// it has changes — the same Commit button as its card. Resting the pointer
// on a file's change dot shows what changed in it. The file the site's page
// was built from is scrolled to the top and marked.

import { h, icon, iconButton, replace } from "../lib/dom";
import { activeRepo, emit, folderKey, on, store } from "../lib/store";
import * as actions from "../lib/actions";
import type { FileEntry, RepoRecord } from "../lib/types";
import { openMenu } from "./menu";
import { openAddFolder } from "./add-folder";
import { confirmModal, promptModal } from "./modal";
import { openExternal } from "../lib/ipc";
import { publicAddress, splitPublicUrl } from "../lib/site";
import { openCommit } from "./commit";
import { changeTooltip } from "./diff-view";
import { resizeHandle } from "./resize";
import { uploadSection } from "./upload-folder";

const narrow = typeof window !== "undefined" ? window.matchMedia("(max-width: 1080px)") : null;

/** Show or hide the repositories column; where it is a drawer, open the drawer. */
export function toggleRepos() {
  if (narrow?.matches) actions.setLayout({ drawer: true });
  else actions.setLayout({ repos: !store.layout.repos });
}

export function filesColumn(): HTMLElement {
  const title = h("h2", { "data-tauri-drag-region": "" }, "Files");
  const body = h("div", { class: "column-body" });
  const search = h("input", { class: "input search", type: "search", placeholder: "Filter posts", "aria-label": "Filter posts" });
  search.addEventListener("input", () => {
    store.filter = search.value;
    render();
  });

  const badge = h("span", { class: "badge" });
  const commitBtn = iconButton(
    "commit",
    "Commit changes…",
    () => {
      const id = store.activeRepoId;
      if (id) void openCommit(id);
    },
    { hidden: true },
  );
  commitBtn.append(badge);

  const globeBtn = iconButton(
    "globe",
    "Browse the site",
    () => {
      const id = store.activeRepoId;
      if (!id) return;
      if (store.browsing?.repoId === id) actions.closeBrowser();
      else actions.browseSite(id);
    },
    { class: "icon-btn site-btn", hidden: true },
  );

  const col = h(
    "section",
    { class: "column col-files", "aria-label": "Files" },
    h(
      "div",
      { class: "column-head", "data-tauri-drag-region": "" },
      iconButton("back", "Repositories", () => actions.setLayout({ pane: "repos" }), { class: "icon-btn only-phone" }),
      iconButton("sidebar", "Show or hide the repositories", () => toggleRepos(), { class: "icon-btn not-phone" }),
      title,
      globeBtn,
      h("span", { class: "grow", "data-tauri-drag-region": "" }),
      commitBtn,
    ),
    h("div", { class: "files-filter" }, search),
    body,
    resizeHandle("files"),
  );

  /** The site page's file last scrolled to, so it is scrolled to once. */
  let scrolledTo = "";

  function render() {
    const repo = activeRepo();
    title.textContent = repo ? repo.name : "Files";
    const site = repo ? splitPublicUrl(repo.publicUrl) : null;
    globeBtn.hidden = !site;
    globeBtn.classList.toggle("on", !!repo && store.browsing?.repoId === repo.id);
    globeBtn.title = site ? `Browse ${site.origin.replace(/^https?:\/\//, "")}${site.base}` : "";
    const changes = repo ? (store.status[repo.id]?.changes.length ?? 0) : 0;
    commitBtn.hidden = !changes;
    badge.textContent = String(changes);
    commitBtn.title = `Commit ${changes} change${changes === 1 ? "" : "s"}… (⇧⌘K)`;
    if (!repo) {
      replace(body, h("div", { class: "empty" }, h("strong", null, "No repository selected"), "Choose one on the left, or add one."));
      return;
    }
    const uploads = repo.uploadFolders ?? [];
    replace(
      body,
      repo.folders.map((f) => folderSection(repo, f)),
      uploads.map((f) => uploadSection(repo, f)),
      repo.folders.length + uploads.length === 0 ? h("div", { class: "empty" }, h("strong", null, "No folders yet"), "Add the folder your posts live in.") : null,
      h("button", { class: "add-row", type: "button", onclick: () => void openAddFolder(repo.id) }, icon("plus"), "Add Folder"),
    );
    findSiteHit();
  }

  /** Bring the site page's file to the top of the column, under its
   *  folder's name, the first time it is drawn. A file near the end of the
   *  list gets room under the list to get there, while the site is showing. */
  function findSiteHit() {
    if (!store.browsing) body.style.removeProperty("--hit-room");
    const hit = store.siteHit;
    const key = hit ? `${hit.repoId}:${hit.path}` : "";
    if (key === scrolledTo) return;
    const row = key ? body.querySelector<HTMLElement>(".file-row.site-hit") : null;
    if (key && !row) return; // Not listed yet; the next draw may have it.
    scrolledTo = key;
    if (!row) return;
    row.classList.add("found");
    const head = row.closest(".folder")?.querySelector<HTMLElement>(".folder-head");
    const top = Math.max(0, body.scrollTop + row.getBoundingClientRect().top - body.getBoundingClientRect().top - (head?.offsetHeight ?? 0));
    body.style.removeProperty("--hit-room");
    const room = body.scrollHeight - body.clientHeight;
    if (top > room) body.style.setProperty("--hit-room", `${Math.ceil(top - room)}px`);
    body.scrollTo({ top, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
  on(["repos", "files", "file", "status", "browser"], render);
  render();
  return col;
}

function folderSection(repo: RepoRecord, folder: string): HTMLElement {
  const key = folderKey(repo.id, folder);
  const files = store.files[key];
  const q = store.filter.trim().toLowerCase();
  const shown = (files ?? []).filter((f) => !q || f.title.toLowerCase().includes(q) || f.path.toLowerCase().includes(q));
  const collapsed = store.collapsed.has(key) && !q;

  const menuBtn = iconButton("menu", `${folder} options`, (e) => {
    openMenu(
      e.currentTarget as HTMLElement,
      [
        { label: "New post…", icon: "edit", run: () => void newPost(repo, folder) },
        {
          label: "Refresh",
          icon: "refresh",
          run: async () => {
            await actions.loadFolder(repo.id, folder);
            await actions.refreshStatus(repo.id);
          },
        },
        { separator: true },
        {
          label: "Remove from list",
          icon: "x",
          danger: true,
          run: async () => {
            if (await confirmModal(`Remove ${folder}?`, "It leaves the Files column; nothing in the repository is deleted. You can add it again any time.", "Remove")) {
              await actions.removeFolder(repo.id, folder);
            }
          },
        },
      ],
      "right",
    );
  });

  return h(
    "div",
    { class: `folder ${collapsed ? "collapsed" : ""}` },
    h(
      "div",
      { class: "folder-head" },
      h(
        "button",
        {
          class: "label",
          type: "button",
          title: folder,
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
      menuBtn,
    ),
    h(
      "div",
      { class: "file-list" },
      files === undefined ? h("div", { class: "empty" }, h("span", { class: "spinner" })) : null,
      files && !shown.length ? h("div", { class: "empty" }, q ? "No matches." : "No markdown files here.") : null,
      shown.slice(0, 1500).map((f) => fileRow(repo, folder, f)),
    ),
  );
}

function fileRow(repo: RepoRecord, folder: string, f: FileEntry): HTMLElement {
  const open = store.openFile?.repoId === repo.id && store.openFile.path === f.path;
  const hit = store.siteHit?.repoId === repo.id && store.siteHit.path === f.path;
  const within = f.path.slice(folder.length + 1);
  const sub = [f.date, within !== f.name ? within : f.name].filter(Boolean).join(" · ");
  return h(
    "button",
    {
      class: `file-row ${open ? "active" : ""} ${f.draft ? "draft" : ""} ${hit ? "site-hit" : ""}`,
      type: "button",
      title: f.path,
      onclick: () => void actions.openFile(repo.id, f.path),
      oncontextmenu: (e: MouseEvent) => {
        e.preventDefault();
        openMenu(e.currentTarget as HTMLElement, [
          { label: "Open", icon: "file", run: () => void actions.openFile(repo.id, f.path) },
          ...(f.url ? [{ label: "Open on the site", icon: "globe", run: () => void openExternal(publicAddress(repo, f.url!) ?? "") }] : []),
          ...(f.change ? [{ label: "Discard changes…", icon: "undo", run: () => void discard(repo, f) }] : []),
          { separator: true as const },
          {
            label: "Delete…",
            icon: "trash",
            danger: true,
            run: async () => {
              if (await confirmModal(`Delete ${f.name}?`, "The file is deleted here. Commit and push to remove it from the site too.", "Delete", true)) {
                await actions.deleteFile(repo.id, f.path, folder);
              }
            },
          },
        ]);
      },
    },
    h(
      "div",
      { class: "title" },
      h("span", null, f.title || f.name),
      f.change ? changeDot(repo, f) : null,
    ),
    h("div", { class: "sub" }, sub, f.draft ? " · draft" : ""),
  );
}

function changeDot(repo: RepoRecord, f: FileEntry): HTMLElement {
  const dot = h("span", { class: `dot ${f.change}`, "aria-label": `${f.change}: rest the pointer here to see the changes` });
  changeTooltip(dot, repo.id, f.path, f.change);
  return dot;
}

async function discard(repo: RepoRecord, f: FileEntry) {
  const what = f.change === "added" ? "This file is new; discarding deletes it." : "Your edits since the last commit are lost.";
  if (await confirmModal(`Discard changes to ${f.name}?`, what, "Discard", true)) await actions.discard(repo.id, f.path);
}

async function newPost(repo: RepoRecord, folder: string) {
  const title = await promptModal("New post", "Title", "", "Create", `In ${folder}, named and laid out like the newest post there.`);
  if (title) await actions.createPost(repo.id, folder, title);
}
