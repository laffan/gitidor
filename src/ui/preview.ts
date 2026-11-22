// The preview beside the editor, two ways:
//
// - **Live** (what it opens to): the published site, through the
//   `gitidor://live.<id>` proxy. It shows what is pushed and built, and as you
//   click around it says which source file each page came from, with a button
//   to open it. A note says when the open post has changes the site cannot
//   have yet: not pushed, or pushed and not rebuilt.
// - **Draft**: the open file rendered here, as typed, with images found
//   through the site profile. Works offline; updates as you type.
//
// Clicking text in either moves the editor to the same words.
//
// Both run in a sandboxed frame without `allow-same-origin`: the page's own
// scripts get an opaque origin and cannot reach the app.

import MarkdownIt from "markdown-it";
import { ago, h, icon, iconButton } from "../lib/dom";
import { api, inTauri, openExternal } from "../lib/ipc";
import { knownFile, on, repoById, store } from "../lib/store";
import * as actions from "../lib/actions";
import { parseFrontmatter } from "../lib/frontmatter";
import { liveUrl, publicAddress, splitPublicUrl } from "../lib/site";
import { isDark, onThemeChange } from "../lib/theme";
import type { Clicked } from "../lib/locate";
import { pageShows } from "../lib/published";
import { assetUrl } from "./asset-url";

const md = new MarkdownIt({ html: true, linkify: true, typographer: true });

const DRAFT_CSS = `
:root{--bg:#fff;--text:#1d1d1f;--muted:#6e6e73;--line:rgba(0,0,0,.1);--code:#f3f3f1;--link:#0a6fd6;color-scheme:light}
:root[data-theme=dark]{--bg:#1c1c1e;--text:#e5e5e7;--muted:#9a9aa0;--line:rgba(255,255,255,.1);--code:#2a2a2d;--link:#6cb6ff;color-scheme:dark}
html{background:var(--bg);color:var(--text)}
body{margin:0;font:18px/1.65 "Source Serif 4",Charter,Georgia,serif;-webkit-font-smoothing:antialiased}
main{max-width:40em;margin:0 auto;padding:40px 28px 30vh}
header{margin-bottom:2em}header h1{margin:0 0 .2em}header .meta{color:var(--muted);font:14px -apple-system,system-ui,sans-serif}
h1,h2,h3,h4{font-family:-apple-system,system-ui,sans-serif;line-height:1.25;margin:1.6em 0 .5em}h1{font-size:1.9em}h2{font-size:1.4em}h3{font-size:1.15em}
p,ul,ol,blockquote,pre,table,figure{margin:0 0 1.1em}
a{color:var(--link)}img,video{max-width:100%;height:auto;border-radius:3px}
.image-caption{color:var(--muted);font-size:.85em;margin-top:-.6em}
blockquote{border-left:3px solid var(--line);padding-left:1em;color:var(--muted);margin-left:0}
code{font:.86em "IBM Plex Mono",ui-monospace,monospace;background:var(--code);padding:.1em .3em;border-radius:3px}
pre{background:var(--code);padding:12px 14px;border-radius:6px;overflow:auto}pre code{background:none;padding:0}
hr{border:0;border-top:1px solid var(--line);margin:2em 0}
table{border-collapse:collapse}td,th{border:1px solid var(--line);padding:4px 8px}
mark{background:rgba(255,214,10,.4);color:inherit}
.missing{display:inline-block;padding:6px 10px;border:1px dashed var(--line);border-radius:4px;color:var(--muted);font:13px -apple-system,system-ui,sans-serif}
.fm-error{font:13px -apple-system,system-ui,sans-serif;background:#fdecec;color:#a32020;padding:8px 10px;border-radius:6px;margin-bottom:1.5em}`;

/**
 * Reports where a click on the page's text landed (see `lib/locate.ts`).
 * Must stay identical to `LOCATE_JS` in `src-tauri/src/scheme.rs`, which puts
 * the same function in live pages; a test checks.
 */
export const LOCATE_JS = String.raw`function gitidorLocate(e,post){if(e.button!==0||e.defaultPrevented)return;var s=window.getSelection&&getSelection();if(s&&!s.isCollapsed)return;var t=e.target;if(!t||!t.closest||t.closest("a,button,input,textarea,select,label,summary,video,audio,[contenteditable]"))return;var n=null,o=0,r;if(document.caretRangeFromPoint){r=document.caretRangeFromPoint(e.clientX,e.clientY);if(r){n=r.startContainer;o=r.startOffset;}}else if(document.caretPositionFromPoint){r=document.caretPositionFromPoint(e.clientX,e.clientY);if(r){n=r.offsetNode;o=r.offset;}}if(!n||n.nodeType!==3||!document.body)return;var b=n.parentElement;b=b&&(b.closest("p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th,dt,dd,figcaption,caption")||b);if(!b)return;function upto(el,before){var g=document.createRange();g.selectNodeContents(el);if(before)g.setEnd(n,o);else g.setStart(n,o);return g.toString();}var all=document.body.textContent.length||1;post({type:"locate",before:upto(b,1).slice(-400),after:upto(b,0).slice(0,400),ratio:upto(document.body,1).length/all});}`;

const FRAME_SCRIPT = `
${LOCATE_JS}
function up(m){m.gitidor=1;parent.postMessage(m,"*");}
addEventListener("message",function(e){var d=e.data||{};if(d.gitidor!=="draft")return;
if(d.theme)document.documentElement.dataset.theme=d.theme;
if(d.html!==undefined)document.getElementById("doc").innerHTML=d.html;});
document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest("a[href]");
if(a){e.preventDefault();if(/^https?:|^mailto:/.test(a.href))up({type:"external",url:a.href});return;}
gitidorLocate(e,up);});
up({type:"draft-ready"});`;

/** A post as a reader sees it: the title and the rendered body's text. */
export function readerText(markdown: string): string {
  const fm = parseFrontmatter(markdown);
  const bodyText = fm ? markdown.slice(fm.end) : markdown;
  const title = typeof fm?.data.title === "string" ? `${fm.data.title}\n` : "";
  const doc = new DOMParser().parseFromString(md.render(bodyText), "text/html");
  return title + (doc.body.textContent ?? "");
}

/** How long after a push the live preview keeps checking for the rebuild. */
const REBUILD_WINDOW = 15 * 60 * 1000;

export interface Preview {
  el: HTMLElement;
  update(): void;
}

/** `onLocate` hears clicks on the open post's text, in either mode. */
export function previewPane(onLocate: (click: Clicked) => void): Preview {
  const draftTab = h("button", { type: "button", onclick: () => setMode("draft") }, "Draft");
  const liveTab = h("button", { type: "button", onclick: () => setMode("live") }, "Live");
  const back = iconButton("back", "Back", () => post({ type: "back" }));
  const forward = iconButton("forward", "Forward", () => post({ type: "forward" }));
  const reload = iconButton("refresh", "Reload", () => post({ type: "reload" }));
  const address = h("div", { class: "address" }, h("span"));
  const external = iconButton("external", "Open in the browser", () => {
    const repo = repoById(store.openFile?.repoId ?? "");
    const url = store.preview.mode === "live" && repo ? publicAddress(repo, livePath) : currentPublicAddress();
    if (url) void openExternal(url);
  });
  const editThis = h("button", { class: "btn small", type: "button", hidden: true }, icon("edit", 14), "Edit this post");
  const spacer = h("span", { style: "flex:1" });
  const note = h("div", { class: "preview-note" });
  const frameBox = h("div", { class: "preview-frame" });
  const el = h(
    "aside",
    { class: "preview", hidden: true, "aria-label": "Preview" },
    h("div", { class: "preview-bar" }, h("div", { class: "segmented" }, liveTab, draftTab), back, forward, reload, address, spacer, editThis, external),
    frameBox,
    note,
  );

  let frame: HTMLIFrameElement | null = null;
  let frameMode: "draft" | "live" | null = null;
  let frameRepo = "";
  let livePath = "/";
  let draftReady = false;
  let pending: Record<string, unknown> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The file the live page last mapped to, so the button can hide once it is open. */
  let lastHit: { repoId: string; path: string } | null = null;
  /** The source file of the page the live frame shows, when it is known. */
  let pageFile: string | null = null;
  /** The path the live frame was opened at, for the open file. */
  let openedPath = "";
  /** The live page's text, as its script last reported it. */
  let pageText: string | null = null;

  function post(msg: Record<string, unknown>) {
    frame?.contentWindow?.postMessage({ gitidor: store.preview.mode === "draft" ? "draft" : 1, ...msg }, "*");
  }

  function setMode(mode: "draft" | "live") {
    store.preview.mode = mode;
    update();
  }

  function currentPublicAddress(): string | null {
    const f = store.openFile;
    const repo = repoById(f?.repoId ?? "");
    const entry = f && knownFile(f.repoId, f.path);
    return repo && entry?.url ? publicAddress(repo, entry.url) : (repo?.publicUrl ?? null);
  }

  function makeFrame(mode: "draft" | "live", src?: string) {
    frameBox.replaceChildren();
    frameBox.className = `preview-frame ${mode}`;
    frame = h("iframe", { sandbox: "allow-scripts allow-forms", referrerpolicy: "no-referrer", title: mode === "draft" ? "Draft preview" : "Live site" });
    frameMode = mode;
    draftReady = false;
    pageText = null;
    if (mode === "draft") {
      frame.srcdoc = `<!doctype html><html data-theme="${isDark() ? "dark" : "light"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${DRAFT_CSS}</style></head><body><main id="doc"></main><script>${FRAME_SCRIPT}</script></body></html>`;
    } else if (src) {
      frame.src = src;
    }
    frameBox.appendChild(frame);
  }

  function renderDraft() {
    const f = store.openFile;
    const repo = repoById(f?.repoId ?? "");
    if (!f || !repo) return;
    if (frameMode !== "draft" || frameRepo !== repo.id) {
      frameRepo = repo.id;
      makeFrame("draft");
    }
    const fm = parseFrontmatter(f.text);
    const bodyText = fm ? f.text.slice(fm.end) : f.text;
    let html = md.render(bodyText);
    const title = typeof fm?.data.title === "string" ? fm.data.title : "";
    const date = fm?.data.date instanceof Date ? fm.data.date.toISOString().slice(0, 10) : typeof fm?.data.date === "string" ? fm.data.date : "";
    if (title && !/^\s*#\s/.test(bodyText)) {
      html = `<header><h1>${escapeHtml(title)}</h1>${date ? `<div class="meta">${escapeHtml(date)}</div>` : ""}</header>${html}`;
    }
    if (fm?.error) html = `<div class="fm-error">The frontmatter has an error: ${escapeHtml(fm.error)}</div>${html}`;
    html = rewriteImages(html, (src) => assetUrl(repo, f.path, src));
    const msg: Record<string, unknown> = { html, theme: isDark() ? "dark" : "light" };
    if (draftReady) post(msg);
    else pending = msg;
    note.replaceChildren();
  }

  function renderLive() {
    const f = store.openFile;
    const repo = repoById(f?.repoId ?? store.activeRepoId ?? "");
    if (!repo) return;
    const entry = f ? knownFile(f.repoId, f.path) : undefined;
    const site = splitPublicUrl(repo.publicUrl);
    if (!site) {
      frameBox.replaceChildren(h("div", { class: "editor-empty" }, h("div", null, h("div", { class: "big" }, "No public URL"), "Add the site's address in the repository's settings.")));
      frameMode = null;
      return;
    }
    const path = `${site.base}${entry?.url ?? "/"}`;
    const wanted = inTauri ? liveUrl(repo.id, path) : `${site.origin}${path}`;
    if (frameMode !== "live" || frameRepo !== repo.id || frame?.dataset.for !== f?.path) {
      frameRepo = repo.id;
      livePath = path;
      openedPath = path;
      pageFile = f?.path ?? null;
      makeFrame("live", wanted);
      frame!.dataset.for = f?.path ?? "";
    }
    address.firstElementChild!.textContent = publicAddress(repo, livePath) ?? repo.publicUrl;
    drawNote();
  }

  /**
   * The line under the live page. It speaks only about the open post, and
   * only while the frame shows that post's page: the post has changes that
   * are not pushed (so the site cannot have them), or it was pushed lately
   * and the page does not show the new version yet (the site is rebuilding).
   * Redrawn whenever the repository's status changes, so it goes as soon as
   * a push does, and when the page reports its text, so the rebuild note
   * goes when the page catches up.
   */
  function drawNote() {
    if (store.preview.mode !== "live" || frameMode !== "live") return;
    const f = store.openFile;
    const repo = repoById(frameRepo);
    const lines: Node[] = [];
    const onItsPage = !!f && !!repo && f.repoId === repo.id && pageFile === f.path;
    const entry = f ? knownFile(f.repoId, f.path) : undefined;
    if (f && entry && !entry.url && livePath === openedPath) lines.push(h("span", null, "This file has no published URL in the site structure; showing the home page."));
    if (onItsPage && repo && f) {
      const st = store.status[repo.id];
      const notPushed = f.text !== f.saved || !st?.hasUpstream || st.changes.some((c) => c.path === f.path) || st.unpushed.includes(f.path);
      const push = store.pushed[repo.id];
      if (st && notPushed) {
        lines.push(h("span", null, icon("push", 12), st.hasUpstream ? " This post has changes that are not pushed yet; the live site shows what is pushed." : ` ${st.branch} is not on GitHub yet; the live site shows what is pushed.`));
      } else if (push && push.previous.has(f.path) && Date.now() - push.at < REBUILD_WINDOW && pageText !== null) {
        const before = push.previous.get(f.path) ?? null;
        if (before === f.text || pageShows(readerText(f.text), before === null ? null : readerText(before), pageText)) {
          // Seen on the site: nothing more to wait for.
          push.previous.delete(f.path);
        } else {
          lines.push(
            h(
              "span",
              null,
              icon("refresh", 12),
              ` Pushed ${ago(push.at)}; the page does not show it yet, so the site may still be rebuilding. `,
              h("button", { class: "link", type: "button", onclick: () => post({ type: "reload" }) }, "Reload"),
            ),
          );
        }
      }
    }
    if (!inTauri) lines.push(h("span", null, "Browser mode: “Edit this post” works in the app."));
    note.replaceChildren(...lines);
  }

  function update() {
    const open = store.preview.open && !!store.openFile;
    el.hidden = !open;
    el.parentElement?.classList.toggle("previewing", open);
    draftTab.classList.toggle("on", store.preview.mode === "draft");
    liveTab.classList.toggle("on", store.preview.mode === "live");
    const live = store.preview.mode === "live";
    back.hidden = forward.hidden = reload.hidden = address.hidden = !live;
    spacer.hidden = live;
    const f = store.openFile;
    editThis.hidden = !live || !lastHit || (!!f && f.repoId === lastHit.repoId && f.path === lastHit.path);
    if (!open) return;
    if (live) renderLive();
    else {
      clearTimeout(timer);
      timer = setTimeout(() => renderDraft(), 120);
    }
  }

  window.addEventListener("message", async (e) => {
    if (!frame || e.source !== frame.contentWindow) return;
    const d = (e.data ?? {}) as { gitidor?: unknown; type?: string; path?: string; url?: string; title?: string; text?: string; before?: string; after?: string; ratio?: number };
    if (!d.gitidor) return;
    if (d.type === "draft-ready") {
      draftReady = true;
      if (pending) post(pending);
      pending = null;
    } else if (d.type === "external" && d.url) {
      void openExternal(d.url);
    } else if (d.type === "locate" && typeof d.before === "string" && typeof d.after === "string") {
      // In the live site, only the open post's own page is worth searching.
      const f = store.openFile;
      if (!f || (frameMode === "live" && (pageFile !== f.path || frameRepo !== f.repoId))) return;
      onLocate({ before: d.before, after: d.after, ratio: typeof d.ratio === "number" ? d.ratio : undefined });
    } else if (d.type === "nav" && typeof d.path === "string") {
      livePath = d.path;
      pageText = typeof d.text === "string" ? d.text : null;
      const repo = repoById(frameRepo);
      if (!repo) return;
      address.firstElementChild!.textContent = publicAddress(repo, d.path) ?? d.path;
      const hit = await api.siteLookup(repo.id, d.path.split("?")[0]).catch(() => null);
      lastHit = hit ? { repoId: repo.id, path: hit } : null;
      // The page the frame opened on keeps its file even when the lookup
      // cannot name one (a redirect, an unusual permalink).
      const samePage = d.path.split("?")[0].replace(/\/+$/, "") === openedPath.replace(/\/+$/, "");
      pageFile = hit ?? (samePage ? (frame?.dataset.for ?? null) : null);
      const isOpen = hit && store.openFile?.path === hit && store.openFile.repoId === repo.id;
      editThis.hidden = !hit || !!isOpen;
      editThis.onclick = () => {
        if (!hit) return;
        if (frame) frame.dataset.for = hit;
        void actions.openFile(repo.id, hit);
      };
      editThis.title = hit ?? "";
      drawNote();
    }
  });

  on(["file", "preview"], update);
  on("save", () => {
    if (store.preview.open && store.preview.mode === "draft") update();
    else if (store.preview.open) drawNote();
  });
  on("status", () => {
    if (store.preview.open) drawNote();
  });
  onThemeChange(() => {
    if (frameMode === "draft") post({ theme: isDark() ? "dark" : "light" });
  });

  return { el, update };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Point every `<img src>` (and `srcset`) at the file behind it. */
export function rewriteImages(html: string, resolve: (src: string) => string | null): string {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}`, "text/html");
  doc.querySelectorAll("img[src], source[src], video[src]").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    const url = resolve(src);
    if (url) img.setAttribute("src", url);
    else {
      const missing = doc.createElement("span");
      missing.className = "missing";
      missing.textContent = `Image not found: ${src}`;
      img.replaceWith(missing);
    }
  });
  doc.querySelectorAll("img[srcset], source[srcset]").forEach((img) => {
    const set = (img.getAttribute("srcset") ?? "")
      .split(",")
      .map((part) => {
        const [u, d] = part.trim().split(/\s+/, 2);
        return `${resolve(u) ?? u}${d ? ` ${d}` : ""}`;
      })
      .join(", ");
    img.setAttribute("srcset", set);
  });
  return doc.body.innerHTML;
}
