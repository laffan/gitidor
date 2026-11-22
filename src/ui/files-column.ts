// Column 2: the folders chosen for the active repository, each with its
// markdown files under it and a menu (new post, refresh, remove) across from
// its name. "Add Folder" is always last. The head has the button that shows
// and hides the repositories column, the repository's name, and — when it
// has changes — the same Commit button as its card. Resting the pointer on
// a file's change dot shows what changed in it.

import { h, icon, iconButton, replace } from "../lib/dom";
import { activeRepo, emit, folderKey, on, store } from "../lib/store";
import * as actions from "../lib/actions";
import type { FileEntry, RepoRecord } from "../lib/types";
import { openMenu } from "./menu";
import { openAddFolder } from "./add-folder";
import { confirmModal, promptModal } from "./modal";
import { openExternal } from "../lib/ipc";
import { publicAddress } from "../lib/site";
import { openCommit } from "./commit";
import { changeTooltip } from "./diff-view";
import { resizeHandle } from "./resize";

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

  const col = h(
    "section",
    { class: "column col-files", "aria-label": "Files" },
    h(
      "div",
      { class: "column-head", "data-tauri-drag-region": "" },
      iconButton("back", "Repositories", () => actions.setLayout({ pane: "repos" }), { class: "icon-btn only-phone" }),
      iconButton("sidebar", "Show or hide the repositories", () => toggleRepos(), { class: "icon-btn not-phone" }),
      title,
      commitBtn,
    ),
    h("div", { class: "files-filter" }, search),
    body,
    resizeHandle("files"),
  );

  function render() {
    const repo = activeRepo();
    title.textContent = repo ? repo.name : "Files";
    const changes = repo ? (store.status[repo.id]?.changes.length ?? 0) : 0;
    commitBtn.hidden = !changes;
    badge.textContent = String(changes);
    commitBtn.title = `Commit ${changes} change${changes === 1 ? "" : "s"}… (⇧⌘K)`;
    if (!repo) {
      replace(body, h("div", { class: "empty" }, h("strong", null, "No repository selected"), "Choose one on the left, or add one."));
      return;
    }
    replace(
      body,
      repo.folders.map((f) => folderSection(repo, f)),
      repo.folders.length === 0 ? h("div", { class: "empty" }, h("strong", null, "No folders yet"), "Add the folder your posts live in.") : null,
      h("button", { class: "add-row", type: "button", onclick: () => void openAddFolder(repo.id) }, icon("plus"), "Add Folder"),
    );
  }
  on(["repos", "files", "file", "status"], render);
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
  const within = f.path.slice(folder.length + 1);
  const sub = [f.date, within !== f.name ? within : f.name].filter(Boolean).join(" · ");
  return h(
    "button",
    {
      class: `file-row ${open ? "active" : ""} ${f.draft ? "draft" : ""}`,
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
