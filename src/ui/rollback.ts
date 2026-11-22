// The Rollback sheet: before a repository goes back to its last commit, or
// to GitHub's branch as last fetched, it lists what would be lost — the
// commits GitHub does not have, and every file whose changes go — with each
// file's changes word by word, and asks.

import { ago, h, icon } from "../lib/dom";
import { api } from "../lib/ipc";
import { repoById, store } from "../lib/store";
import * as actions from "../lib/actions";
import type { RollbackPlan } from "../lib/types";
import { openModal } from "./modal";
import { renderFileChanges } from "./diff-view";

export async function openRollback(repoId: string, to: "local" | "remote") {
  const repo = repoById(repoId);
  if (!repo) return;
  await actions.flushSave();
  let plan: RollbackPlan;
  const m = openModal({ title: to === "local" ? "Roll back to the last local commit" : "Roll back to the last remote commit", width: 640 });
  m.body.append(h("div", { class: "empty" }, h("span", { class: "spinner" })));
  try {
    plan = await api.rollbackPlan(repoId, to);
  } catch (e) {
    m.body.replaceChildren(h("div", { class: "notice error" }, (e as Error).message));
    m.foot.append(h("button", { class: "btn", type: "button", onclick: () => m.close() }, "Close"));
    return;
  }

  const branch = store.status[repoId]?.branch ?? "this branch";
  const target = h("span", { class: "mono" }, plan.target.short);
  const lede =
    to === "local"
      ? h("p", { class: "lede" }, "Every file goes back to how it was in the last commit, ", target, ` “${plan.target.summary}”.`)
      : h("p", { class: "lede" }, `${branch} goes back to GitHub's ${branch} as this copy last saw it (checked ${ago(repo.lastFetched)}): `, target, ` “${plan.target.summary}”.`);

  const nothing = !plan.commits.length && !plan.files.length;
  const run = h("button", { class: "btn danger", type: "button", disabled: nothing }, icon("undo", 14), "Roll back");
  m.foot.append(h("button", { class: "btn quiet", type: "button", onclick: () => m.close() }, "Cancel"), run);

  if (nothing) {
    m.body.replaceChildren(lede, h("div", { class: "empty" }, h("strong", null, "Nothing would be lost"), "This copy already matches that commit."));
    return;
  }

  let selected = plan.files[0]?.path ?? "";
  const list = h("div", { class: "change-list" });
  const diff = h("div", { class: "diff", "aria-label": "Changes that would be lost in the selected file" });

  const drawList = () =>
    list.replaceChildren(
      ...plan.files.map((c) =>
        h(
          "div",
          {
            class: `change-row ${c.path === selected ? "selected" : ""}`,
            onclick: () => {
              selected = c.path;
              drawList();
              void showDiff();
            },
          },
          h("span", { class: `dot ${c.kind}` }),
          h("span", { class: "path", title: c.path }, `‎${c.path}`),
          h("span", { class: "kind" }, c.kind),
        ),
      ),
    );

  async function showDiff() {
    const path = selected;
    const kind = plan.files.find((c) => c.path === path)?.kind ?? "modified";
    diff.replaceChildren(h("div", { class: "pd-note" }, "…"));
    const view = await renderFileChanges(repoId, path, kind, plan.base);
    if (selected === path) diff.replaceChildren(view);
  }

  m.body.replaceChildren(
    ...[
    lede,
    h("div", { class: "notice warn", style: "margin-bottom:14px" }, "These are lost. gitidor cannot bring them back afterwards."),
    plan.commits.length
      ? h(
          "div",
          { class: "field" },
          h("div", { class: "label" }, `Commits not on GitHub (${plan.commits.length})`),
          h(
            "div",
            { class: "change-list commit-list" },
            ...plan.commits.map((c) =>
              h("div", { class: "change-row", style: "cursor:default" }, h("span", { class: "mono", style: "color:var(--text-3)" }, c.short), h("span", { class: "summary" }, c.summary), h("span", { class: "kind", style: "width:auto" }, ago(c.time))),
            ),
          ),
        )
      : null,
    plan.files.length
      ? h(
          "div",
          { class: "field", style: "margin-bottom:0" },
          h("div", { class: "label" }, `Changes${to === "remote" ? ", committed or not," : ""} in ${plan.files.length} file${plan.files.length === 1 ? "" : "s"}`),
          list,
          diff,
        )
      : null,
    ].filter((n): n is HTMLDivElement => !!n),
  );
  drawList();
  if (selected) void showDiff();

  run.addEventListener("click", async () => {
    m.setBusy(true);
    const ok = await actions.rollback(repoId, plan);
    m.setBusy(false);
    if (ok) m.close();
    else m.body.append(h("div", { class: "notice error", style: "margin-top:10px" }, store.errors[repoId] ?? "The rollback failed."));
  });
}
