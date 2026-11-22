// gitidor: three columns — repositories (hidden at launch), files, the
// editor — and the window-level shortcuts that work wherever focus is.

import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/400-italic.css";
import "@fontsource/ibm-plex-mono/700.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/400-italic.css";
import "@fontsource/ibm-plex-sans/700.css";
import "@fontsource/source-serif-4/400.css";
import "@fontsource/source-serif-4/400-italic.css";
import "@fontsource/source-serif-4/700.css";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/modal.css";
import "./styles/editor.css";
import "./styles/console.css";

import { h } from "./lib/dom";
import { on, store } from "./lib/store";
import * as actions from "./lib/actions";
import { applyAppearance } from "./lib/theme";
import { reposColumn } from "./ui/repos-column";
import { filesColumn } from "./ui/files-column";
import { editorColumn, toggleColumns, togglePreview } from "./ui/editor-column";
import { openSettings } from "./ui/settings";
import { openCommit } from "./ui/commit";
import { modalIsOpen, promptModal } from "./ui/modal";
import { toast } from "./ui/toast";
import { activeRepo } from "./lib/store";
import { consolePanel, toggleConsole } from "./ui/console";
import { listenForLogs } from "./lib/ipc";
import { log } from "./lib/log";
import { restoreWidths } from "./ui/resize";
import { sideFooter } from "./ui/side-foot";

const app = document.getElementById("app")!;
const scrim = h("div", { class: "drawer-scrim", onclick: () => actions.setLayout({ drawer: false }) });
app.append(reposColumn(), filesColumn(), sideFooter(), editorColumn(), scrim);
restoreWidths();
document.body.appendChild(consolePanel());
void listenForLogs();

function layout() {
  app.classList.toggle("hide-repos", !store.layout.repos);
  app.classList.toggle("hide-files", !store.layout.files);
  app.classList.toggle("show-drawer", store.layout.drawer);
  app.dataset.pane = store.layout.pane;
}
on("layout", layout);
layout();

on("settings", () => applyAppearance(store.settings.appearance));
applyAppearance(store.settings.appearance);

// Shortcuts that belong to the window rather than the editor.
window.addEventListener(
  "keydown",
  (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === "," && !e.shiftKey) {
      e.preventDefault();
      openSettings();
    } else if (key === "y" && e.shiftKey) {
      // ⇧⌘Y, as Xcode shows and hides its debug area.
      e.preventDefault();
      toggleConsole();
    } else if (modalIsOpen()) {
      return;
    } else if (key === "s" && !e.shiftKey) {
      e.preventDefault();
      void actions.flushSave();
    } else if (key === "p" && e.shiftKey) {
      e.preventDefault();
      togglePreview();
    } else if (key === "\\") {
      e.preventDefault();
      toggleColumns();
    } else if (key === "k" && e.shiftKey) {
      e.preventDefault();
      const id = store.activeRepoId;
      if (id) void openCommit(id);
    } else if (key === "n" && !e.shiftKey) {
      e.preventDefault();
      const repo = activeRepo();
      const folder = repo?.folders[0];
      if (!repo || !folder) {
        toast("Add a folder first.");
        return;
      }
      void promptModal("New post", "Title", "", "Create", `In ${folder}.`).then((t) => {
        if (t) void actions.createPost(repo.id, folder, t);
      });
    }
  },
  true,
);

// iOS suspends an app without warning once it is in the background, and may
// end it there; save on the way out rather than hoping for the timer.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void actions.flushSave();
});
window.addEventListener("beforeunload", () => void actions.flushSave());

actions
  .boot()
  .then(() => {
    document.documentElement.classList.toggle("platform-macos", store.platform === "macos");
    log.info("app", `gitidor ${__APP_VERSION__} on ${store.platform || "a browser"} — ${store.repos.length} repositor${store.repos.length === 1 ? "y" : "ies"}${store.online ? "" : ", offline"}`);
    // The repositories column starts hidden, except when there is nothing
    // else to show: "Add Repo" is in it.
    if (!store.repos.length) actions.setLayout({ pane: "repos", repos: true });
  })
  .catch((e) => {
    log.error("app", `gitidor could not start: ${(e as Error).message}`);
    toast(`gitidor could not start: ${(e as Error).message}`, "error", 15000);
  });
