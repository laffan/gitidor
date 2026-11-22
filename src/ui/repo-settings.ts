// One repository's sheet: its name, its public URL, and the site structure
// — routes and image folders — written out so it can be read and corrected,
// whichever way it was worked out.

import { h, icon, iconButton } from "../lib/dom";
import { api } from "../lib/ipc";
import { emit, repoById, store } from "../lib/store";
import * as actions from "../lib/actions";
import type { AssetMap, Route, SiteProfile } from "../lib/types";
import { openModal } from "./modal";
import { toast } from "./toast";

const empty: SiteProfile = { generator: "unknown", source: "manual", routes: [], assets: [], stylesheets: [], suggestedFolders: [], publicUrlHint: "", notes: "" };

export function openRepoSettings(repoId: string) {
  const repo = repoById(repoId);
  if (!repo) return;
  const m = openModal({ title: repo.name, width: 640 });
  let profile: SiteProfile = structuredClone(repo.site ?? empty);

  const name = h("input", { class: "input", value: repo.name });
  const url = h("input", { class: "input", value: repo.publicUrl, placeholder: "https://example.com/", spellcheck: false, autocapitalize: "off" });
  const siteBox = h("div");
  const aiReady = (store.settings.ai.provider === "anthropic" && store.secrets.hasAnthropicKey) || (store.settings.ai.provider === "openai" && store.secrets.hasOpenaiKey);

  const draw = () => {
    const routes = h("div", { class: "group" }, profile.routes.map((r, i) => routeRow(r, i)), addRow("Add route", () => profile.routes.push({ folder: repo.folders[0] ?? "", pattern: "/{path}/" })));
    const assets = h("div", { class: "group" }, profile.assets.map((a, i) => assetRow(a, i)), addRow("Add image folder", () => profile.assets.push({ urlPrefix: "/images/", repoPath: "" })));
    siteBox.replaceChildren(
      h(
        "div",
        { class: "row", style: "margin:4px 0 10px" },
        h("span", { class: "pill" }, profile.generator === "unknown" ? "Generator not recognised" : profile.generator),
        h("span", { class: "pill" }, profile.source === "ai" ? "worked out with AI" : profile.source === "manual" ? "edited by hand" : "read from config"),
        h("span", { style: "flex:1" }),
        h("button", { class: "btn small", type: "button", onclick: () => void redetect(false) }, icon("refresh", 14), "Read config again"),
        h("button", { class: "btn small", type: "button", disabled: !aiReady, title: aiReady ? "" : "Set up a provider under Settings → AI", onclick: () => void redetect(true) }, icon("sparkle", 14), "Ask AI"),
      ),
      ...(profile.notes ? [h("div", { class: "notice info", style: "margin-bottom:12px;white-space:pre-wrap" }, profile.notes)] : []),
      h("div", { class: "group-title" }, "Post URLs"),
      routes,
      h("div", { class: "hint", style: "margin:-10px 0 16px" }, "Tokens: {path} {stem} {fileSlug} {slug} {title} {year} {month} {day} {dir}. A frontmatter permalink wins."),
      h("div", { class: "group-title" }, "Where site URLs live in the repository"),
      assets,
      h("div", { class: "hint", style: "margin:-10px 0 16px" }, "How an image written as /images/blog/a.jpg in a post is found, for inline images and the draft preview. Longest prefix wins."),
    );
  };

  function routeRow(r: Route, i: number) {
    const folder = h("input", { class: "input mono", value: r.folder, placeholder: "posts", oninput: (e: Event) => (r.folder = (e.target as HTMLInputElement).value) });
    const pattern = h("input", { class: "input mono", value: r.pattern, placeholder: "/blog/{slug}/", oninput: (e: Event) => (r.pattern = (e.target as HTMLInputElement).value) });
    return h("div", { class: "opt" }, h("div", { class: "row grow", style: "flex:1" }, h("div", { style: "flex:1" }, folder), h("span", { style: "color:var(--text-3)" }, "→"), h("div", { style: "flex:1.4" }, pattern)), iconButton("x", "Remove", () => {
      profile.routes.splice(i, 1);
      draw();
    }));
  }

  function assetRow(a: AssetMap, i: number) {
    const prefix = h("input", { class: "input mono", value: a.urlPrefix, placeholder: "/images/", oninput: (e: Event) => (a.urlPrefix = (e.target as HTMLInputElement).value) });
    const path = h("input", { class: "input mono", value: a.repoPath, placeholder: "(repository root)", oninput: (e: Event) => (a.repoPath = (e.target as HTMLInputElement).value) });
    return h("div", { class: "opt" }, h("div", { class: "row", style: "flex:1" }, h("div", { style: "flex:1" }, prefix), h("span", { style: "color:var(--text-3)" }, "→"), h("div", { style: "flex:1.2" }, path)), iconButton("x", "Remove", () => {
      profile.assets.splice(i, 1);
      draw();
    }));
  }

  function addRow(label: string, add: () => void) {
    return h("div", { class: "opt", style: "min-height:40px" }, h("button", { class: "link", type: "button", onclick: () => (add(), draw()) }, `+ ${label}`));
  }

  async function redetect(useAi: boolean) {
    m.setBusy(true);
    try {
      profile = await api.detectSite(repoId, useAi);
      store.repos = store.repos.map((r) => (r.id === repoId ? { ...r, site: profile } : r));
      emit("repos");
      draw();
      toast(useAi ? "Site structure worked out with AI." : "Site structure read from the config.");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      m.setBusy(false);
    }
  }

  m.body.append(
    h("div", { class: "row", style: "gap:12px;align-items:flex-start" }, h("div", { class: "field", style: "flex:1" }, h("label", null, "Name"), name), h("div", { class: "field", style: "flex:1.6" }, h("label", null, "Public URL"), url)),
    h("div", { class: "field", style: "margin-bottom:4px" }, h("div", { class: "label" }, "Site structure")),
    siteBox,
  );
  const save = h("button", { class: "btn primary", type: "button" }, "Save");
  save.addEventListener("click", async () => {
    m.setBusy(true);
    try {
      await api.updateRepo(repoId, { name: name.value, publicUrl: url.value });
      await api.saveSite(repoId, profile);
      await actions.reloadRepos();
      await actions.loadFolders(repoId);
      m.close();
    } catch (e) {
      toast((e as Error).message, "error");
      m.setBusy(false);
    }
  });
  m.foot.append(h("div", { class: "hint", style: "margin-right:auto" }, `Cloned from ${repo.remoteUrl}`), h("button", { class: "btn quiet", type: "button", onclick: () => m.close() }, "Cancel"), save);
  draw();
}
