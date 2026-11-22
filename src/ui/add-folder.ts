// The Add Folder sheet: the clone's directories with their markdown counts,
// the site profile's guesses marked, the ones already added greyed out.

import { h, icon } from "../lib/dom";
import { api } from "../lib/ipc";
import { repoById } from "../lib/store";
import * as actions from "../lib/actions";
import type { DirInfo } from "../lib/types";
import { openModal } from "./modal";

export async function openAddFolder(repoId: string, opts: { firstTime?: boolean } = {}) {
  const repo = repoById(repoId);
  if (!repo) return;
  const m = openModal({ title: opts.firstTime ? `Which folders hold ${repo.name}'s posts?` : "Add Folder", width: 520 });
  const list = h("div", { class: "dir-tree" }, h("div", { class: "empty" }, h("span", { class: "spinner" })));
  const filter = h("input", { class: "input search", placeholder: "Filter folders", style: "margin-bottom:8px" });
  const showAll = h("input", { type: "checkbox", class: "switch" });
  const addBtn = h("button", { class: "btn primary", type: "button", disabled: true }, "Add");
  const chosen = new Set<string>();
  const suggested = new Set(repo.site?.suggestedFolders ?? []);
  const existing = new Set(repo.folders);

  m.body.append(
    ...[opts.firstTime
      ? h(
          "p",
          { style: "margin:0 0 12px;color:var(--text-2);line-height:1.5" },
          repo.site && repo.site.generator !== "unknown"
            ? `This looks like ${/^[aeiou]/i.test(label(repo.site.generator)) ? "an" : "a"} ${label(repo.site.generator)} site. The folders it publishes posts from are marked; choose any you want to edit.`
            : "Choose the folders you want to edit. Most sites keep posts in one.",
        )
      : null].filter((n): n is HTMLParagraphElement => !!n),
    filter,
    list,
    h("label", { class: "row", style: "margin-top:10px;color:var(--text-2);gap:8px" }, showAll, "Show folders without markdown"),
  );
  m.foot.append(h("button", { class: "btn quiet", type: "button", onclick: () => m.close() }, opts.firstTime ? "Later" : "Cancel"), addBtn);

  let dirs: DirInfo[] = [];
  try {
    dirs = await api.listDirs(repoId);
  } catch (e) {
    list.replaceChildren(h("div", { class: "notice error" }, (e as Error).message));
    return;
  }
  if (opts.firstTime) for (const s of suggested) if (!existing.has(s) && dirs.some((d) => d.path === s)) {
    chosen.add(s);
    break; // Just the most likely one; the rest are a tap away.
  }

  const draw = () => {
    const q = filter.value.toLowerCase();
    const rows = dirs
      .filter((d) => showAll.checked || d.markdownTotal > 0)
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
          icon("folder", 15),
          h("span", { class: "name" }, q ? d.path : (d.path.split("/").pop() ?? d.path)),
          h("span", { class: "n" }, added ? "added" : d.markdown ? `${d.markdown} md` : d.markdownTotal ? `${d.markdownTotal} below` : ""),
        );
        box.addEventListener("change", () => {
          if (box.checked) chosen.add(d.path);
          else chosen.delete(d.path);
          sync();
        });
        return row;
      }),
    );
    if (!rows.length) list.append(h("div", { class: "empty" }, "No folders with markdown files. Turn on “Show folders without markdown” to choose another."));
  };
  const sync = () => {
    addBtn.disabled = chosen.size === 0;
    addBtn.textContent = chosen.size > 1 ? `Add ${chosen.size} folders` : "Add folder";
  };
  addBtn.addEventListener("click", async () => {
    m.setBusy(true);
    try {
      await actions.setFolders(repoId, [...repo.folders, ...chosen]);
      m.close();
    } catch (e) {
      m.setBusy(false);
      m.body.append(h("div", { class: "notice error", style: "margin-top:10px" }, (e as Error).message));
    }
  });
  filter.addEventListener("input", draw);
  showAll.addEventListener("change", draw);
  draw();
  sync();
}

function label(generator: string): string {
  return ({ eleventy: "Eleventy", jekyll: "Jekyll", hugo: "Hugo", astro: "Astro" } as Record<string, string>)[generator] ?? generator;
}
