// Column 1: the repositories, as cards. A card says which branch is checked
// out, what has changed here, how far this copy is from GitHub, and what was
// last committed; the active card carries the pull / commit / push buttons.

import { ago, h, icon, iconButton, replace } from "../lib/dom";
import { emit, on, store } from "../lib/store";
import * as actions from "../lib/actions";
import { api, openExternal } from "../lib/ipc";
import type { RepoRecord } from "../lib/types";
import { openMenu, type MenuItem } from "./menu";
import { openAddRepo } from "./add-repo";
import { openCommit } from "./commit";
import { openRepoSettings } from "./repo-settings";
import { openSettings } from "./settings";
import { confirmModal, promptModal } from "./modal";
import { toast } from "./toast";

export function reposColumn(): HTMLElement {
  const body = h("div", { class: "column-body" });
  const offline = h("span", { class: "pill warn", hidden: true, title: "Editing and committing work offline. Pull and push wait for the network." }, icon("cloudoff", 12), "Offline");
  const col = h(
    "section",
    { class: "column col-repos", "aria-label": "Repositories" },
    h(
      "div",
      { class: "column-head", "data-tauri-drag-region": "" },
      h("h2", { "data-tauri-drag-region": "" }, "Repositories"),
      iconButton("x", "Close", () => actions.setLayout({ drawer: false }), { class: "icon-btn only-narrow" }),
    ),
    body,
    h(
      "div",
      { class: "column-foot" },
      iconButton("gear", "Settings (⌘,)", () => openSettings()),
      h("span", { style: "flex:1" }),
      offline,
    ),
  );

  const render = () => {
    offline.hidden = store.online;
    replace(
      body,
      store.repos.map(card),
      store.repos.length === 0
        ? h("div", { class: "empty" }, h("strong", null, "No repositories yet"), "Add the repository your site is built from. It is cloned once; after that, editing works offline.")
        : null,
      h("button", { class: "add-row", type: "button", onclick: () => openAddRepo() }, icon("plus"), "Add Repo"),
    );
  };
  on(["repos", "status"], render);
  window.addEventListener("online", () => {
    store.online = true;
    render();
  });
  window.addEventListener("offline", () => {
    store.online = false;
    render();
  });
  render();
  return col;
}

function card(repo: RepoRecord): HTMLElement {
  const status = store.status[repo.id];
  const busy = store.busy[repo.id];
  const error = store.errors[repo.id];
  const active = store.activeRepoId === repo.id;
  const changes = status?.changes.length ?? 0;

  const facts: (HTMLElement | null)[] = [];
  const branch = h(
    "button",
    {
      class: "pill",
      type: "button",
      title: "Switch branch",
      style: "border:0;cursor:pointer",
      onclick: (e: Event) => {
        e.stopPropagation();
        branchMenu(repo, e.currentTarget as HTMLElement);
      },
    },
    icon("branch", 12),
    status?.branch ?? "…",
  );
  facts.push(branch);
  if (changes) facts.push(h("span", { class: "pill accent", title: "Files changed here and not committed" }, `${changes} change${changes === 1 ? "" : "s"}`));
  if (status && status.ahead) facts.push(h("span", { title: status.hasUpstream ? "Commits not pushed yet" : "This branch is not on GitHub yet" }, `↑${status.ahead}`));
  if (status && status.behind) facts.push(h("span", { title: "New commits on GitHub — pull to get them" }, `↓${status.behind}`));
  if (status && !changes && !status.ahead && !status.behind && status.hasUpstream) facts.push(h("span", { title: `Matches GitHub as of ${ago(repo.lastFetched)}` }, "Up to date"));

  const last = status?.head ? h("div", { class: "last", title: `${status.head.short} by ${status.head.author}` }, `${status.head.summary} · ${ago(status.head.time)}`) : null;

  const actionRow = h(
    "div",
    { class: "actions" },
    iconButton("pull", status?.behind ? `Pull ${status.behind} commit${status.behind === 1 ? "" : "s"}` : "Pull", (e) => {
      e.stopPropagation();
      void actions.pull(repo.id);
    }),
    (() => {
      const b = iconButton("commit", "Commit changes…", (e) => {
        e.stopPropagation();
        openCommit(repo.id);
      }, { disabled: !changes });
      if (changes) b.append(h("span", { class: "badge" }, String(changes)));
      return b;
    })(),
    (() => {
      const b = iconButton("push", status?.ahead ? `Push ${status.ahead} commit${status.ahead === 1 ? "" : "s"}` : "Push", (e) => {
        e.stopPropagation();
        void actions.push(repo.id);
      }, { disabled: !status?.ahead });
      if (status?.ahead) b.append(h("span", { class: "badge" }, String(status.ahead)));
      return b;
    })(),
    iconButton("globe", "Open the site", (e) => {
      e.stopPropagation();
      if (repo.publicUrl) void openExternal(repo.publicUrl);
    }, { disabled: !repo.publicUrl }),
    h("span", { style: "flex:1" }),
    iconButton("more", "More", (e) => {
      e.stopPropagation();
      openMenu(e.currentTarget as HTMLElement, repoMenu(repo), "right");
    }),
  );

  return h(
    "div",
    {
      class: `repo-card ${active ? "active" : ""}`,
      role: "button",
      tabindex: "0",
      "aria-current": active ? "true" : undefined,
      onclick: () => void actions.selectRepo(repo.id, { showFiles: true }),
      onkeydown: (e: KeyboardEvent) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          void actions.selectRepo(repo.id, { showFiles: true });
        }
      },
    },
    h(
      "div",
      { class: "name" },
      h("span", null, repo.name),
      changes ? h("span", { class: "dot modified", title: "Uncommitted changes", style: "flex:none" }) : null,
    ),
    h("div", { class: "owner" }, `${repo.owner}/${repo.repo}`),
    h("div", { class: "meta" }, facts),
    last,
    busy ? h("div", { class: "busy-line" }, h("span", { class: "spinner", style: "margin-right:6px;vertical-align:-2px" }), busy) : null,
    error && !busy ? h("div", { class: "err-line", role: "alert" }, error) : null,
    actionRow,
  );
}

function repoMenu(repo: RepoRecord): MenuItem[] {
  const aiReady =
    (store.settings.ai.provider === "anthropic" && store.secrets.hasAnthropicKey) ||
    (store.settings.ai.provider === "openai" && store.secrets.hasOpenaiKey);
  return [
    { label: "Repository settings…", icon: "gear", run: () => openRepoSettings(repo.id) },
    {
      label: aiReady ? "Detect site structure with AI" : "Detect site structure (set up AI in Settings)",
      icon: "sparkle",
      disabled: !aiReady,
      run: () => void detectWithAi(repo.id),
    },
    { label: "Check GitHub for changes", icon: "refresh", run: () => void actions.fetchRepo(repo.id) },
    { separator: true },
    { label: "Open on GitHub", icon: "github", run: () => void openExternal(`https://github.com/${repo.owner}/${repo.repo}`) },
    { label: "Open the site", icon: "globe", disabled: !repo.publicUrl, run: () => void openExternal(repo.publicUrl) },
    { separator: true },
    { label: "Remove…", icon: "trash", danger: true, run: () => void removeRepo(repo) },
  ];
}

export async function detectWithAi(id: string) {
  await actions.gitStep(id, "Reading the site's structure…", async () => {
    const profile = await api.detectSite(id, true);
    store.repos = store.repos.map((r) => (r.id === id ? { ...r, site: profile } : r));
    emit("repos");
    await actions.loadFolders(id);
    toast(`Site structure updated${profile.notes ? `: ${profile.notes.split("\n")[0]}` : "."}`);
  });
}

async function removeRepo(repo: RepoRecord) {
  const changes = store.status[repo.id]?.changes.length ?? 0;
  const ahead = store.status[repo.id]?.ahead ?? 0;
  const risk = changes || ahead ? ` It has ${[changes ? `${changes} uncommitted change${changes === 1 ? "" : "s"}` : "", ahead ? `${ahead} unpushed commit${ahead === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ")}, which will be lost.` : "";
  const ok = await confirmModal(
    `Remove ${repo.name}?`,
    `This deletes the local copy from this device. The repository on GitHub is not touched.${risk}`,
    "Remove",
    true,
  );
  if (!ok) return;
  try {
    await api.removeRepo(repo.id, true);
    if (store.openFile?.repoId === repo.id) store.openFile = null;
    for (const key of Object.keys(store.files)) if (key.startsWith(`${repo.id}:`)) delete store.files[key];
    if (store.activeRepoId === repo.id) store.activeRepoId = null;
    await actions.reloadRepos();
    if (!store.activeRepoId && store.repos[0]) await actions.selectRepo(store.repos[0].id);
    emit("files", "file", "save");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

async function branchMenu(repo: RepoRecord, anchor: HTMLElement) {
  let branches;
  try {
    branches = await api.branches(repo.id, false);
  } catch (e) {
    toast((e as Error).message, "error");
    return;
  }
  const items: MenuItem[] = [{ heading: "Branches" }];
  for (const b of branches.local) {
    items.push({ label: b, icon: "branch", checked: b === branches.current, run: () => b !== branches.current && void actions.checkout(repo.id, b, false) });
  }
  if (branches.remoteOnly.length) {
    items.push({ heading: "On GitHub" });
    for (const b of branches.remoteOnly) items.push({ label: b, icon: "github", run: () => void actions.checkout(repo.id, b, false) });
  }
  items.push(
    { separator: true },
    {
      label: "New branch…",
      icon: "plus",
      run: async () => {
        const name = await promptModal("New branch", "Branch name", "", "Create", `Starts from ${branches.current}. It is created on GitHub the first time you push.`);
        if (name) await actions.checkout(repo.id, name.replace(/\s+/g, "-"), true);
      },
    },
    {
      label: "Refresh from GitHub",
      icon: "refresh",
      run: async () => {
        try {
          await api.branches(repo.id, true);
          toast("Branch list refreshed.");
        } catch (e) {
          toast((e as Error).message, "error");
        }
      },
    },
  );
  openMenu(anchor, items);
}
