// The Commit sheet: every changed file, ticked; the diff of whichever one is
// selected; a message written from the files' titles until somebody types one.

import { h, icon } from "../lib/dom";
import { api } from "../lib/ipc";
import { repoById, store } from "../lib/store";
import * as actions from "../lib/actions";
import { openModal, confirmModal } from "./modal";

export async function openCommit(repoId: string) {
  const repo = repoById(repoId);
  if (!repo) return;
  await actions.flushSave();
  const status = (await actions.refreshStatus(repoId)) ?? store.status[repoId];
  const changes = status?.changes ?? [];
  const m = openModal({ title: `Commit to ${status?.branch ?? "branch"}`, width: 620 });
  if (!changes.length) {
    m.body.append(h("div", { class: "empty" }, h("strong", null, "Nothing to commit"), "Every file matches the last commit."));
    m.foot.append(h("button", { class: "btn", type: "button", onclick: () => m.close() }, "Close"));
    return;
  }

  const chosen = new Set(changes.map((c) => c.path));
  let selected = changes[0].path;
  let messageEdited = false;
  const message = h("textarea", { class: "input", rows: 2, "aria-label": "Commit message" }) as HTMLTextAreaElement;
  message.addEventListener("input", () => (messageEdited = true));
  const list = h("div", { class: "change-list" });
  const diff = h("div", { class: "diff", "aria-label": "Changes in the selected file" });
  const commitBtn = h("button", { class: "btn", type: "button" }, "Commit");
  const pushBtn = h("button", { class: "btn primary", type: "button" }, icon("push", 14), "Commit & Push");
  const note = h("div", { class: "hint", style: "margin-right:auto" });

  const drawList = () => {
    list.replaceChildren(
      ...changes.map((c) => {
        const box = h("input", { type: "checkbox", checked: chosen.has(c.path), "aria-label": `Include ${c.path}` });
        box.addEventListener("click", (e) => e.stopPropagation());
        box.addEventListener("change", () => {
          if (box.checked) chosen.add(c.path);
          else chosen.delete(c.path);
          sync();
        });
        return h(
          "div",
          {
            class: `change-row ${c.path === selected ? "selected" : ""}`,
            onclick: () => {
              selected = c.path;
              drawList();
              void showDiff();
            },
          },
          box,
          h("span", { class: `dot ${c.kind}` }),
          h("span", { class: "path", title: c.path }, `‎${c.path}`),
          h("span", { class: "kind" }, c.kind),
          h(
            "button",
            {
              class: "icon-btn",
              type: "button",
              title: "Discard this change",
              onclick: async (e: Event) => {
                e.stopPropagation();
                if (await confirmModal(`Discard ${c.path}?`, c.kind === "added" ? "The file is new; discarding deletes it." : "The file goes back to how it was in the last commit.", "Discard", true)) {
                  m.close();
                  await actions.discard(repoId, c.path);
                  void openCommit(repoId);
                }
              },
            },
            icon("undo", 14),
          ),
        );
      }),
    );
  };

  async function showDiff() {
    diff.replaceChildren(h("div", { class: "hunk" }, "…"));
    try {
      const text = await api.diff(repoId, selected);
      const lines = text.split("\n").slice(0, 1500);
      diff.replaceChildren(
        ...lines.map((line) =>
          h(
            "div",
            {
              class: line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") || line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("+++") || line.startsWith("---") ? "hunk" : "",
            },
            line || " ",
          ),
        ),
      );
    } catch (e) {
      diff.replaceChildren(h("div", { class: "hunk" }, (e as Error).message));
    }
  }

  const sync = () => {
    const paths = changes.filter((c) => chosen.has(c.path)).map((c) => c.path);
    if (!messageEdited) message.value = paths.length ? actions.commitMessage(paths) : "";
    commitBtn.disabled = pushBtn.disabled = !paths.length;
    note.textContent = `${paths.length} of ${changes.length} file${changes.length === 1 ? "" : "s"}`;
  };

  const run = async (andPush: boolean) => {
    const paths = changes.filter((c) => chosen.has(c.path)).map((c) => c.path);
    if (!message.value.trim()) {
      message.focus();
      return;
    }
    m.setBusy(true);
    const ok = await actions.commit(repoId, paths, message.value.trim(), andPush);
    m.setBusy(false);
    if (ok) m.close();
    else m.body.append(h("div", { class: "notice error", style: "margin-top:10px" }, store.errors[repoId] ?? "The commit failed."));
  };
  commitBtn.addEventListener("click", () => void run(false));
  pushBtn.addEventListener("click", () => void run(true));
  message.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void run(store.settings.git.pushAfterCommit);
    }
  });

  if (!store.settings.git.pushAfterCommit) {
    commitBtn.classList.add("primary");
    pushBtn.classList.remove("primary");
  }

  m.body.append(
    h("div", { class: "field" }, h("label", null, "Message"), message, h("div", { class: "hint" }, `⌘↩ to ${store.settings.git.pushAfterCommit ? "commit and push" : "commit"}. Committing works offline; pushing needs the network.`)),
    h("div", { class: "field", style: "margin-bottom:0" }, h("div", { class: "label" }, "Files"), list, diff),
  );
  m.foot.append(note, h("button", { class: "btn quiet", type: "button", onclick: () => m.close() }, "Cancel"), commitBtn, pushBtn);
  drawList();
  sync();
  void showDiff();
  requestAnimationFrame(() => message.focus());
}
