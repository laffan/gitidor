// The published site in the editor column, in place of the post (which stays
// open underneath), opened from the globe beside the repository's name in
// the Files column. It is the live preview's browser (site-frame.ts) given
// the whole column, with its controls in the column's own bar.
//
// When a page is one the site profile maps to a file, "Edit Post" appears in
// the bar and the Files column finds the file (store.siteHit). Opening the
// file, with the button or from the Files column, puts the editor back;
// so do × and Esc.

import { h, icon, iconButton } from "../lib/dom";
import { inTauri, openExternal } from "../lib/ipc";
import { on, repoById, store } from "../lib/store";
import * as actions from "../lib/actions";
import { splitPublicUrl } from "../lib/site";
import { modalIsOpen } from "./modal";
import { siteFrame } from "./site-frame";

export interface SiteView {
  /** The page, in place of the editor and preview. */
  el: HTMLElement;
  /** Back, forward, reload, the address, Edit Post, open in the browser,
   *  close: for the editor's bar. */
  bar: HTMLElement;
  /** The page's source file, for the editor's footer. */
  info: HTMLElement;
}

export function siteView(): SiteView {
  const frame = siteFrame({
    onNav: (page) => {
      if (store.browsing?.repoId !== page.repoId) return;
      actions.siteReached(page.file ? { repoId: page.repoId, path: page.file } : null);
    },
  });
  const editBtn = h(
    "button",
    {
      class: "btn small",
      type: "button",
      hidden: true,
      onclick: () => {
        const hit = store.siteHit;
        if (hit) void actions.openFile(hit.repoId, hit.path);
      },
    },
    icon("edit", 14),
    "Edit Post",
  );
  const external = iconButton("external", "Open in the browser", () => {
    const url = frame.url();
    if (url) void openExternal(url);
  });
  const closeBtn = iconButton("x", "Close (esc)", () => actions.closeBrowser());
  const bar = h("span", { class: "site-bar", hidden: true, "data-tauri-drag-region": "" }, frame.back, frame.forward, frame.reload, frame.address, editBtn, external, closeBtn);
  const info = h("span", { class: "site-info" });
  const el = h("div", { class: "site-view", hidden: true }, frame.box);

  /** The `store.browsing` the frame was opened for. */
  let opened: typeof store.browsing = null;

  function render() {
    const b = store.browsing;
    el.hidden = bar.hidden = !b;
    if (!b) {
      if (opened) frame.close();
      opened = null;
      editBtn.hidden = true;
      info.textContent = "";
      return;
    }
    const repo = repoById(b.repoId);
    if (!repo) {
      // Removed while it was showing.
      actions.closeBrowser();
      return;
    }
    if (opened !== b) {
      opened = b;
      frame.open(repo, `${splitPublicUrl(repo.publicUrl)?.base ?? ""}/`);
    }
    const hit = store.siteHit?.repoId === repo.id ? store.siteHit : null;
    const postOpen = store.openFile?.repoId === repo.id;
    editBtn.hidden = !hit;
    editBtn.title = hit ? `Open ${hit.path} in the editor` : "";
    closeBtn.title = postOpen ? "Back to the post (esc)" : "Close (esc)";
    info.textContent = hit ? hit.path : inTauri ? "" : "Browser mode: “Edit Post” works in the app.";
  }

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && store.browsing && !modalIsOpen() && !document.querySelector(".menu")) {
      e.preventDefault();
      actions.closeBrowser();
    }
  });
  on(["browser", "repos", "file"], render);
  render();

  return { el, bar, info };
}
