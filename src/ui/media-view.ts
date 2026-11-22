// A picture, video or sound from an upload folder, shown in the editor column
// in place of the post (which stays open underneath: closing goes back to
// it, and "Insert into post" puts the file's markdown at its caret). The
// footer says how big it is and where the site serves it.
//
// Video and sound load through `gitidor://local`, which answers byte ranges;
// WebKit needs that to play media from a custom scheme.

import { h, icon, iconButton } from "../lib/dom";
import { folderKey, on, repoById, store } from "../lib/store";
import * as actions from "../lib/actions";
import { openExternal } from "../lib/ipc";
import { imageReference, publicAddress } from "../lib/site";
import type { RepoRecord, UploadEntry } from "../lib/types";
import { assetUrl } from "./asset-url";
import { modalIsOpen } from "./modal";
import { openMenu } from "./menu";
import { insertIntoPost, mediaKind, uploadMenuItems } from "./upload-menu";

export interface MediaView {
  /** The stage, in place of the editor and preview. */
  el: HTMLElement;
  /** Buttons for the editor's bar. */
  actions: HTMLElement;
  /** Size, dimensions and published address, for the editor's footer. */
  info: HTMLElement;
  link: HTMLElement;
  /** The path shown as the column's title. */
  title(): Node[];
}

function duration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "";
  const s = Math.round(seconds);
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function mediaView(): MediaView {
  const stage = h("div", { class: "media-stage" });
  const el = h("div", { class: "media-view", hidden: true }, stage);
  const info = h("span", { class: "media-info" });
  const link = h("span");
  const insertBtn = h("button", { class: "btn small", type: "button" }, icon("edit", 14), "Insert into post");
  const moreBtn = iconButton("more", "More", (e) => {
    const c = current();
    if (c) openMenu(e.currentTarget as HTMLElement, uploadMenuItems(c.repo, c.folder, c.entry, { heading: false }), "right");
  });
  const closeBtn = iconButton("x", "Close (esc)", () => actions.closeViewer());
  const bar = h("span", { class: "media-actions" }, insertBtn, moreBtn, closeBtn);

  let shownKey = "";
  let facts = "";

  function current(): { repo: RepoRecord; folder: string; entry: UploadEntry } | null {
    const v = store.viewing;
    const repo = v && repoById(v.repoId);
    const entry = v && store.uploads[folderKey(v.repoId, v.folder)]?.find((f) => f.path === v.path);
    return v && repo && entry ? { repo, folder: v.folder, entry } : null;
  }

  insertBtn.addEventListener("click", () => {
    const c = current();
    if (!c) return;
    actions.closeViewer();
    insertIntoPost(c.repo, c.entry);
  });

  function stop() {
    stage.querySelectorAll("video, audio").forEach((m) => (m as HTMLMediaElement).pause());
  }

  function drawInfo(entry: UploadEntry) {
    const change = entry.change === "added" ? "new, not committed" : entry.change ? "changed, not committed" : "";
    info.textContent = [facts, actions.size(entry.size), change].filter(Boolean).join(" · ");
  }

  function failed(kind: string) {
    stop();
    stage.replaceChildren(
      h(
        "div",
        { class: "editor-empty" },
        h("div", null, h("div", { class: "big" }, `This ${kind} could not be ${kind === "picture" ? "shown" : "played"} here`), "Its format may not be one this system can open."),
      ),
    );
  }

  function render() {
    const v = store.viewing;
    el.hidden = !v;
    bar.hidden = !v;
    if (!v) {
      stop();
      stage.replaceChildren();
      info.textContent = "";
      link.replaceChildren();
      shownKey = "";
      return;
    }
    const c = current();
    if (!c) {
      // Deleted, discarded, or its folder removed: nothing left to show.
      if (store.uploads[folderKey(v.repoId, v.folder)] !== undefined) actions.closeViewer();
      return;
    }
    const { repo, entry } = c;
    const postOpen = store.openFile?.repoId === repo.id;
    insertBtn.hidden = !postOpen;
    insertBtn.title = postOpen ? `Put it in ${store.openFile!.path.split("/").pop()} at the caret` : "";
    closeBtn.title = postOpen ? "Back to the post (esc)" : "Close (esc)";

    const ref = imageReference(repo.site ?? null, "", entry.path);
    const url = ref.startsWith("/") ? publicAddress(repo, ref) : null;
    link.replaceChildren(
      ...(url
        ? [h("a", { href: "#", class: "link", style: "color:inherit", title: "Where the site serves it, once pushed", onclick: (e: Event) => (e.preventDefault(), void openExternal(url)) }, url.replace(/^https?:\/\//, ""))]
        : []),
    );

    const key = `${repo.id}:${entry.path}:${entry.modified}:${entry.size}`;
    if (key !== shownKey) {
      shownKey = key;
      facts = "";
      stop();
      const kind = mediaKind(entry.name);
      const src = assetUrl(repo, "", `/${entry.path}`, true) ?? "";
      if (kind === "image") {
        const img = h("img", { src, alt: entry.name, draggable: false });
        img.addEventListener("load", () => {
          facts = `${img.naturalWidth} × ${img.naturalHeight}`;
          drawInfo(entry);
        });
        img.addEventListener("error", () => failed("picture"));
        stage.replaceChildren(img);
      } else if (kind === "video") {
        const video = h("video", { src, controls: true, preload: "metadata", playsInline: true });
        video.addEventListener("loadedmetadata", () => {
          facts = [video.videoWidth ? `${video.videoWidth} × ${video.videoHeight}` : "", duration(video.duration)].filter(Boolean).join(" · ");
          drawInfo(entry);
        });
        video.addEventListener("error", () => failed("video"));
        stage.replaceChildren(video);
      } else if (kind === "audio") {
        const audio = h("audio", { src, controls: true, preload: "metadata" });
        audio.addEventListener("loadedmetadata", () => {
          facts = duration(audio.duration);
          drawInfo(entry);
        });
        audio.addEventListener("error", () => failed("sound"));
        stage.replaceChildren(h("div", { class: "media-audio" }, icon("music", 56), h("div", { class: "name" }, entry.name), audio));
      } else {
        stage.replaceChildren();
      }
    }
    drawInfo(entry);
  }

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && store.viewing && !modalIsOpen() && !document.querySelector(".menu")) {
      e.preventDefault();
      actions.closeViewer();
    }
  });
  on(["viewer", "files", "file"], render);
  render();

  return {
    el,
    actions: bar,
    info,
    link,
    title() {
      const v = store.viewing;
      if (!v) return [];
      const name = v.path.split("/").pop() ?? v.path;
      const folder = v.path.slice(0, -name.length - 1);
      return [...(folder ? [h("span", null, `${folder} / `)] : []), h("b", null, name)];
    },
  };
}
