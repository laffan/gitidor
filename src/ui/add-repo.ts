// The Add Repo sheet: an address, a test, a branch, the public URL, and the
// one clone that has to happen online.

import { h, icon } from "../lib/dom";
import { api, onCloneProgress } from "../lib/ipc";
import { store } from "../lib/store";
import * as actions from "../lib/actions";
import type { RepoCheck, RepoSummary } from "../lib/types";
import { openModal } from "./modal";
import { openAddFolder } from "./add-folder";
import { openSettings } from "./settings";

export function openAddRepo(initialAddress = "") {
  const m = openModal({ title: "Add Repo", width: 540 });
  let check: RepoCheck | null = null;
  let urlEdited = false;

  const address = h("input", {
    class: "input mono",
    placeholder: "git@github.com:owner/repo.git",
    value: initialAddress,
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: false,
    "aria-label": "Repository address",
  });
  const testBtn = h("button", { class: "btn", type: "button", onclick: () => void test() }, "Test access");
  const result = h("div", { class: "check-result" });
  const picker = h("div");
  const branch = h("select", { class: "select", disabled: true, "aria-label": "Branch" }, h("option", { value: "" }, "Default branch"));
  const publicUrl = h("input", {
    class: "input",
    placeholder: "https://owner.github.io/repo/ or https://example.com/",
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: false,
    "aria-label": "Public URL",
    oninput: () => (urlEdited = true),
  });
  const progress = h("div", { class: "progress", hidden: true }, h("div"));
  const progressText = h("div", { class: "hint", hidden: true });
  const addBtn = h("button", { class: "btn primary", type: "button", onclick: () => void add() }, "Clone & Add");

  address.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void test();
  });
  address.addEventListener("input", () => {
    check = null;
    result.replaceChildren();
  });

  const signedIn = store.secrets.hasGithubToken;
  m.body.append(
    h(
      "div",
      { class: "field" },
      h("label", null, "Repository"),
      h("div", { class: "row" }, h("div", { class: "grow" }, address), testBtn),
      h(
        "div",
        { class: "hint" },
        "The SSH or HTTPS address from GitHub's Code button, or just owner/repo. ",
        signedIn
          ? h("button", { class: "link", type: "button", onclick: () => void showPicker() }, "Choose from your repositories")
          : h("span", null, "Private repositories need a token: ", h("button", { class: "link", type: "button", onclick: () => openSettings("github") }, "sign in to GitHub"), "."),
      ),
      picker,
    ),
    result,
    h("div", { class: "field" }, h("label", null, "Branch"), branch, h("div", { class: "hint" }, "The branch you edit. You can switch later from the card.")),
    h(
      "div",
      { class: "field" },
      h("label", null, "Public URL"),
      publicUrl,
      h("div", { class: "hint" }, "Where the site is served — GitHub Pages or a custom domain. The live preview loads pages from here, and posts link back to their files from it."),
    ),
    progress,
    progressText,
  );
  m.foot.append(h("button", { class: "btn quiet", type: "button", onclick: () => m.close() }, "Cancel"), addBtn);

  async function test() {
    const value = address.value.trim();
    if (!value) return;
    testBtn.disabled = true;
    result.replaceChildren(h("div", { class: "notice info" }, h("span", { class: "spinner", style: "margin-right:8px;vertical-align:-2px" }), "Asking GitHub…"));
    try {
      check = await api.githubCheckRepo(value);
      const c = check;
      const facts = [
        h("span", { class: "pill" }, c.private ? "Private" : "Public"),
        h("span", { class: `pill ${c.canPush ? "accent" : "warn"}` }, c.canPush ? "You can push" : c.signedIn ? "Read-only for this token" : "Read-only until you sign in"),
        h("span", { class: "pill" }, icon("branch", 12), `default: ${c.defaultBranch}`),
        h("span", { class: "pill" }, `${c.branches.length} branch${c.branches.length === 1 ? "" : "es"}`),
      ];
      result.replaceChildren(
        h(
          "div",
          { class: `notice ${c.canPush ? "ok" : "warn"}` },
          h("strong", null, c.fullName),
          c.description ? h("div", { style: "color:var(--text-2);margin-top:2px" }, c.description) : null,
          h("div", { class: "facts" }, facts),
          !c.canPush ? h("div", { style: "margin-top:6px" }, "You can clone and edit, but pushing will fail without write access.") : null,
        ),
      );
      branch.replaceChildren(...c.branches.map((b) => h("option", { value: b, selected: b === c.defaultBranch }, b)));
      if (!c.branches.length) branch.append(h("option", { value: "" }, "Default branch"));
      branch.disabled = false;
      if (!urlEdited || !publicUrl.value) publicUrl.value = c.pagesUrl;
    } catch (e) {
      result.replaceChildren(h("div", { class: "notice error" }, (e as Error).message));
    } finally {
      testBtn.disabled = false;
    }
  }

  async function showPicker() {
    picker.replaceChildren(h("div", { class: "hint" }, h("span", { class: "spinner", style: "margin-right:6px;vertical-align:-2px" }), "Loading your repositories…"));
    let repos: RepoSummary[];
    try {
      repos = await api.githubListRepos();
    } catch (e) {
      picker.replaceChildren(h("div", { class: "notice error", style: "margin-top:6px" }, (e as Error).message));
      return;
    }
    const search = h("input", { class: "input search", placeholder: "Filter", style: "margin-top:8px" });
    const list = h("div", { class: "repo-picker" });
    const draw = () => {
      const q = search.value.toLowerCase();
      list.replaceChildren(
        ...repos
          .filter((r) => r.fullName.toLowerCase().includes(q))
          .slice(0, 100)
          .map((r) =>
            h(
              "button",
              {
                type: "button",
                onclick: () => {
                  address.value = r.fullName;
                  picker.replaceChildren();
                  void test();
                },
              },
              icon(r.private ? "github" : "globe", 14),
              h("div", { style: "min-width:0;flex:1" }, h("div", null, r.fullName), r.description ? h("div", { class: "desc" }, r.description) : null),
              r.canPush ? null : h("span", { class: "pill warn" }, "read-only"),
            ),
          ),
      );
    };
    search.addEventListener("input", draw);
    draw();
    picker.replaceChildren(search, list);
    search.focus();
  }

  async function add() {
    const value = address.value.trim();
    if (!value) {
      address.focus();
      return;
    }
    const requestId = Math.random().toString(36).slice(2);
    const bar = progress.firstElementChild as HTMLElement;
    progress.hidden = false;
    progressText.hidden = false;
    progressText.textContent = "Connecting to GitHub…";
    m.setBusy(true);
    const stop = await onCloneProgress((p) => {
      if (p.requestId !== requestId) return;
      const pct = p.total ? Math.round((p.received / p.total) * 100) : 0;
      bar.style.width = `${pct}%`;
      progressText.textContent = `Receiving ${p.received.toLocaleString()} of ${p.total.toLocaleString()} objects · ${(p.bytes / 1048576).toFixed(1)} MB`;
    });
    try {
      const record = await api.addRepo(requestId, value, publicUrl.value.trim(), branch.disabled ? "" : branch.value);
      m.close();
      await actions.reloadRepos();
      await actions.refreshStatus(record.id);
      await actions.selectRepo(record.id, { showFiles: true });
      openAddFolder(record.id, { firstTime: true });
    } catch (e) {
      progress.hidden = true;
      progressText.hidden = true;
      result.replaceChildren(h("div", { class: "notice error" }, (e as Error).message));
      m.setBusy(false);
    } finally {
      stop();
    }
  }

  if (initialAddress) void test();
}
