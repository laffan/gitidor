// A small browser for a repository's published site: back, forward, reload
// and the address, over a frame loaded through the `gitidor://live.<id>`
// proxy. The live preview beside a post uses one (preview.ts), and so does
// the site browser that takes the editor column's place (site-view.ts).
//
// The proxy puts a script in every page that reports where the page is and
// its text (`nav`), routes off-site links to the system browser
// (`external`), and reports clicks on text (`locate`). Each `nav` is looked
// up against the site profile, so the page's source file comes with it.
//
// The frame is sandboxed without `allow-same-origin`: the page's own scripts
// get an opaque origin and cannot reach the app.

import { h, iconButton } from "../lib/dom";
import { api, inTauri, openExternal } from "../lib/ipc";
import { repoById } from "../lib/store";
import { liveUrl, splitPublicUrl } from "../lib/site";
import type { Clicked } from "../lib/locate";
import type { RepoRecord } from "../lib/types";

/** A page the frame reached: its path (base path included), its text, and
 *  the file it was built from, if the site profile can name one. */
export interface SitePage {
  repoId: string;
  path: string;
  text: string | null;
  file: string | null;
}

export interface SiteFrame {
  back: HTMLButtonElement;
  forward: HTMLButtonElement;
  reload: HTMLButtonElement;
  address: HTMLElement;
  /** Holds the frame; `.preview-frame.live`. */
  box: HTMLElement;
  /** Load `path` (base path included) of the repository's site, afresh.
   *  False, with a note in the box, when the repository has no public URL. */
  open(repo: RepoRecord, path: string): boolean;
  /** Take the frame away. */
  close(): void;
  /** Send the page's script a message (`back`, `forward`, `reload`). */
  post(msg: Record<string, unknown>): void;
  /** The public address of the page showing, or of the site. */
  url(): string | null;
  readonly frame: HTMLIFrameElement | null;
  readonly repoId: string;
  /** The page's path as it last reported it, or the one it was opened at. */
  readonly path: string;
}

export interface SiteFrameHooks {
  /** A page loaded and its source file was looked up. */
  onNav?(page: SitePage): void;
  /** Text on the page was clicked. */
  onLocate?(click: Clicked): void;
}

export function siteFrame(hooks: SiteFrameHooks = {}): SiteFrame {
  const back = iconButton("back", "Back", () => post({ type: "back" }));
  const forward = iconButton("forward", "Forward", () => post({ type: "forward" }));
  const reload = iconButton("refresh", "Reload", () => post({ type: "reload" }));
  const address = h("div", { class: "address" }, h("span"));
  const box = h("div", { class: "preview-frame live" });

  let frame: HTMLIFrameElement | null = null;
  let repoId = "";
  let path = "/";
  /** Counts pages, so a slow lookup for an earlier one cannot land on a later one. */
  let seq = 0;

  function post(msg: Record<string, unknown>) {
    frame?.contentWindow?.postMessage({ gitidor: 1, ...msg }, "*");
  }

  /** The page's public address. `path` already has the site's base path
   *  in it, so it goes after the origin alone. */
  function pageAddress(): string | null {
    const site = splitPublicUrl(repoById(repoId)?.publicUrl ?? "");
    return site ? `${site.origin}${path.startsWith("/") ? path : `/${path}`}` : null;
  }

  function showAddress() {
    address.firstElementChild!.textContent = pageAddress() ?? repoById(repoId)?.publicUrl ?? "";
  }

  function open(repo: RepoRecord, at: string): boolean {
    seq++;
    repoId = repo.id;
    path = at;
    const site = splitPublicUrl(repo.publicUrl);
    box.classList.toggle("empty", !site);
    if (!site) {
      frame = null;
      box.replaceChildren(h("div", { class: "editor-empty" }, h("div", null, h("div", { class: "big" }, "No public URL"), "Add the site's address in the repository's settings.")));
      address.firstElementChild!.textContent = "";
      return false;
    }
    frame = h("iframe", { sandbox: "allow-scripts allow-forms", referrerpolicy: "no-referrer", title: "Live site" });
    frame.src = inTauri ? liveUrl(repo.id, at) : `${site.origin}${at}`;
    box.replaceChildren(frame);
    showAddress();
    return true;
  }

  function close() {
    seq++;
    frame = null;
    box.replaceChildren();
    box.classList.remove("empty");
  }

  window.addEventListener("message", async (e) => {
    if (!frame || e.source !== frame.contentWindow) return;
    const d = (e.data ?? {}) as { gitidor?: unknown; type?: string; path?: string; url?: string; text?: string; before?: string; after?: string; ratio?: number };
    if (!d.gitidor) return;
    if (d.type === "external" && d.url) {
      void openExternal(d.url);
    } else if (d.type === "locate" && typeof d.before === "string" && typeof d.after === "string") {
      hooks.onLocate?.({ before: d.before, after: d.after, ratio: typeof d.ratio === "number" ? d.ratio : undefined });
    } else if (d.type === "nav" && typeof d.path === "string") {
      const n = ++seq;
      const id = repoId;
      path = d.path;
      showAddress();
      const text = typeof d.text === "string" ? d.text : null;
      const file = await api.siteLookup(id, d.path.split("?")[0]).catch(() => null);
      if (n !== seq) return;
      hooks.onNav?.({ repoId: id, path: d.path, text, file });
    }
  });

  return {
    back,
    forward,
    reload,
    address,
    box,
    open,
    close,
    post,
    url: pageAddress,
    get frame() {
      return frame;
    },
    get repoId() {
      return repoId;
    },
    get path() {
      return path;
    },
  };
}
