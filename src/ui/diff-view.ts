// Showing what changed in a file, word by word: deletions struck through in
// red, insertions highlighted in green. The same view is the tooltip on a
// file's change dot in the Files column, the diff in the Commit sheet and the
// list of losses in the Rollback sheet.

import { h } from "../lib/dom";
import { api } from "../lib/ipc";
import { store } from "../lib/store";
import { countWords, proseDiff, type Block, type Part } from "../lib/diff";

const BINARY = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|heic|pdf|mp4|m4v|webm|mov|mp3|m4a|wav|ogg|woff2?|ttf|otf|eot|zip|gz)$/i;

/** Long unchanged stretches inside a changed paragraph are cut to their ends. */
const KEEP = 90;

function clip(text: string, first: boolean, last: boolean): string {
  if (text.length <= KEEP * 2 + 20 || text.includes("\n")) return text;
  const head = text.slice(0, KEEP).replace(/\S*$/, "");
  const tail = text.slice(-KEEP).replace(/^\S*/, "");
  if (first && !last) return `…${tail}`;
  if (last && !first) return `${head}…`;
  if (first && last) return text;
  return `${head} … ${tail}`;
}

function parts(list: Part[]): (Node | string)[] {
  return list.map((p, i) => {
    if (p.kind === "eq") return clip(p.text, i === 0, i === list.length - 1);
    // A change that is only space: show where it is.
    const shown = p.text.trim() ? p.text : p.text.includes("\n") ? `¶${p.text}` : "·";
    return h(p.kind, null, shown);
  });
}

export function renderBlocks(blocks: Block[]): HTMLElement {
  const el = h("div", { class: "prose-diff" });
  if (!blocks.length) {
    el.append(h("div", { class: "pd-note" }, "No changes to the text."));
    return el;
  }
  for (const b of blocks) {
    if (b.kind === "gap") el.append(h("div", { class: "pd-gap" }, `⋯ ${b.count} unchanged line${b.count === 1 ? "" : "s"}`));
    else if (b.kind === "context") el.append(h("p", { class: "pd-context" }, b.text));
    else el.append(h("p", { class: "pd-change" }, ...parts(b.parts)));
  }
  return el;
}

/** The file as it is now: the editor's text if it is open, else the disk's. */
async function currentText(repoId: string, path: string): Promise<string | null> {
  const f = store.openFile;
  if (f && f.repoId === repoId && f.path === path) return f.text;
  return api.readFile(repoId, path).catch(() => null);
}

export interface FileChanges {
  blocks: Block[] | null;
  note: string;
}

/** What changed in `path` since `rev` (HEAD unless a rollback says otherwise). */
export async function fileChanges(repoId: string, path: string, kind: string, rev = "HEAD"): Promise<FileChanges> {
  if (BINARY.test(path)) {
    const what = kind === "added" ? "added" : kind === "deleted" ? "deleted" : "changed";
    return { blocks: null, note: `A binary file, ${what}. Its contents are not shown.` };
  }
  try {
    const [before, after] = await Promise.all([api.show(repoId, rev, path), currentText(repoId, path)]);
    if (before === null && after === null) return { blocks: null, note: "Nothing to compare." };
    const blocks = proseDiff(before ?? "", after ?? "");
    const { added, removed } = countWords(blocks);
    const note =
      before === null ? `New file · ${added} word${added === 1 ? "" : "s"}` : after === null ? `Deleted · ${removed} word${removed === 1 ? "" : "s"}` : `${added} word${added === 1 ? "" : "s"} added · ${removed} removed`;
    return { blocks, note };
  } catch (e) {
    return { blocks: null, note: (e as Error).message };
  }
}

/** The changes as one element, for a sheet. */
export async function renderFileChanges(repoId: string, path: string, kind: string, rev = "HEAD"): Promise<HTMLElement> {
  const c = await fileChanges(repoId, path, kind, rev);
  return h("div", null, h("div", { class: "pd-summary" }, c.note), c.blocks ? renderBlocks(c.blocks) : null);
}

// ── the tooltip on a change dot ─────────────────────────────────────────────

let tip: HTMLElement | null = null;
let tipKey = "";
let showTimer: ReturnType<typeof setTimeout> | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

function closeTip() {
  clearTimeout(showTimer);
  cancelHide();
  tip?.remove();
  tip = null;
  tipKey = "";
  document.removeEventListener("pointermove", onMove, true);
  document.removeEventListener("pointerdown", onDown, true);
  document.removeEventListener("keydown", onKey, true);
  window.removeEventListener("blur", closeTip);
}

function scheduleHide() {
  if (hideTimer === undefined) hideTimer = setTimeout(closeTip, 220);
}

function cancelHide() {
  clearTimeout(hideTimer);
  hideTimer = undefined;
}

// The Files column redraws while it is hovered (a save refreshes the dots),
// which replaces the dot under the pointer without a pointerleave; so watch
// where the pointer is rather than trust the element.
function onMove(e: PointerEvent) {
  const t = e.target as Element | null;
  if (t?.closest?.(".diff-tip") || t?.closest?.(`[data-diff-key="${CSS.escape(tipKey)}"]`)) cancelHide();
  else scheduleHide();
}

function onDown(e: Event) {
  if (!(e.target as Element | null)?.closest?.(".diff-tip")) closeTip();
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") closeTip();
}

function place(box: HTMLElement, anchor: DOMRect) {
  const w = box.offsetWidth;
  const hgt = box.offsetHeight;
  let left = anchor.right + 12;
  if (left + w > window.innerWidth - 8) left = Math.max(8, anchor.left - w - 12);
  const top = Math.max(8, Math.min(anchor.top - 14, window.innerHeight - hgt - 8));
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
}

async function openTip(anchor: HTMLElement, repoId: string, path: string, kind: string, key: string) {
  closeTip();
  const rect = anchor.getBoundingClientRect();
  const name = path.split("/").pop() ?? path;
  const summary = h("span", { class: "pd-summary" }, "…");
  const body = h("div", { class: "diff-tip-body" }, h("span", { class: "spinner" }));
  const box = h(
    "div",
    { class: "diff-tip", role: "tooltip" },
    h("div", { class: "diff-tip-head" }, h("span", { class: `dot ${kind}` }), h("b", null, name), h("span", { class: "since" }, "since the last commit"), summary),
    body,
  );
  box.addEventListener("pointerenter", cancelHide);
  document.body.appendChild(box);
  tip = box;
  tipKey = key;
  place(box, rect);
  document.addEventListener("pointermove", onMove, true);
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", closeTip);

  const c = await fileChanges(repoId, path, kind);
  if (tip !== box) return;
  summary.textContent = c.note;
  body.replaceChildren(...(c.blocks ? [renderBlocks(c.blocks)] : []));
  body.hidden = !c.blocks;
  place(box, rect);
}

/** Show a file's changes when the pointer rests on `target` (its change dot). */
export function changeTooltip(target: HTMLElement, repoId: string, path: string, kind: string) {
  const key = `${repoId}:${path}`;
  target.dataset.diffKey = key;
  target.addEventListener("pointerenter", (e) => {
    if (e.pointerType === "touch") return;
    cancelHide();
    if (tip && tipKey === key) return;
    clearTimeout(showTimer);
    showTimer = setTimeout(() => void openTip(target, repoId, path, kind, key), 280);
  });
  target.addEventListener("pointerleave", () => {
    clearTimeout(showTimer);
    if (tip) scheduleHide();
  });
}
