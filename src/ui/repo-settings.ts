// One repository's sheet: its name, its public URL, and the site structure
// — routes and image folders — written out so it can be read and corrected,
// whichever way it was worked out, with what the live site said about each
// route when it was last tried there.

import { ago, h, icon, iconButton } from "../lib/dom";
import { api } from "../lib/ipc";
import { emit, repoById, store } from "../lib/store";
import * as actions from "../lib/actions";
import type { AssetMap, Route, RouteCheck, SiteProfile } from "../lib/types";
import { aiReady, checkIsFor, sampleText } from "../lib/preview-links";
import { openModal } from "./modal";
import { toast } from "./toast";

const empty: SiteProfile = { generator: "unknown", source: "manual", routes: [], assets: [], stylesheets: [], suggestedFolders: [], publicUrlHint: "", notes: "" };

/** The parts of a profile a person edits here, to tell whether they did. */
const editable = (p: SiteProfile) => JSON.stringify([p.routes.map((r) => [r.folder, r.pattern, r.capture ?? ""]), p.assets]);

export function openRepoSettings(repoId: string) {
  const repo = repoById(repoId);
  if (!repo) return;
  const m = openModal({ title: repo.name, width: 640 });
  let profile: SiteProfile = structuredClone(repo.site ?? empty);
  let savedShape = editable(profile);

  const name = h("input", { class: "input", value: repo.name });
  const url = h("input", { class: "input", value: repo.publicUrl, placeholder: "https://example.com/", spellcheck: false, autocapitalize: "off" });
  const siteBox = h("div");
  const ai = aiReady();

  const draw = () => {
    const routes = h("div", { class: "group" }, profile.routes.map((r, i) => routeRow(r, i)), addRow("Add route", () => profile.routes.push({ folder: repo.folders[0] ?? "", pattern: "/{path}/" })));
    const assets = h("div", { class: "group" }, profile.assets.map((a, i) => assetRow(a, i)), addRow("Add image folder", () => profile.assets.push({ urlPrefix: "/images/", repoPath: "" })));
    // Content folders no route covers were checked with no pattern.
    const uncovered = (profile.checks ?? []).filter((c) => !c.pattern && !profile.routes.some((r) => r.folder === c.folder));
    siteBox.replaceChildren(
      h(
        "div",
        { class: "row", style: "margin:4px 0 10px;flex-wrap:wrap;gap:6px" },
        h("span", { class: "pill" }, profile.generator === "unknown" ? "Generator not recognised" : profile.generator),
        h("span", { class: "pill" }, profile.source === "ai" ? "worked out with AI" : profile.source === "manual" ? "edited by hand" : "read from config"),
        h("span", { style: "flex:1" }),
        h("button", { class: "btn small", type: "button", onclick: () => void redetect(false) }, icon("refresh", 14), "Read config again"),
        h("button", { class: "btn small", type: "button", disabled: !repo.publicUrl, title: repo.publicUrl ? "Try each folder's URLs on the live site" : "Add the public URL first", onclick: () => void check() }, icon("globe", 14), "Check on live site"),
        h("button", { class: "btn small", type: "button", disabled: !ai, title: ai ? "Work out the routes from the site's code, and correct them against the live site" : "Set up a provider under Settings → AI", onclick: () => void redetect(true) }, icon("sparkle", 14), "Ask AI"),
      ),
      ...(profile.notes ? [h("div", { class: "notice info", style: "margin-bottom:12px;white-space:pre-wrap" }, profile.notes)] : []),
      ...uncovered.map((c) => h("div", { class: "notice warn", style: "margin-bottom:12px" }, c.message)),
      h("div", { class: "group-title" }, "Post URLs", profile.checkedAt ? h("span", { style: "text-transform:none;letter-spacing:0;font-weight:400;margin-left:6px" }, `· checked on the live site ${ago(profile.checkedAt)}`) : null),
      routes,
      h(
        "div",
        { class: "hint", style: "margin:-10px 0 16px;line-height:1.5" },
        "Tokens: {path} {stem} {fileSlug} {slug} {title} {year} {month} {day} {dir}, and {fm.field} for any frontmatter field. Filters after a bar: {stem|number} (0007 → 7), |lower, |upper, |slugify, |strip-date, |replace:a:b. A capture is a regular expression over the file's path in the folder; its groups, (?<name>…) or numbered, are tokens too. A frontmatter permalink wins.",
      ),
      h("div", { class: "group-title" }, "Where site URLs live in the repository"),
      assets,
      h("div", { class: "hint", style: "margin:-10px 0 16px" }, "How an image written as /images/blog/a.jpg in a post is found, for inline images and the draft preview. Longest prefix wins."),
    );
  };

  function routeRow(r: Route, i: number) {
    const folder = h("input", { class: "input mono", value: r.folder, placeholder: "posts", "aria-label": "Folder", oninput: (e: Event) => (r.folder = (e.target as HTMLInputElement).value) });
    const pattern = h("input", { class: "input mono", value: r.pattern, placeholder: "/blog/{slug}/", "aria-label": "URL pattern", oninput: (e: Event) => (r.pattern = (e.target as HTMLInputElement).value) });
    const capture = h("input", {
      class: "input mono small",
      value: r.capture ?? "",
      placeholder: "capture (optional): ^(?<n>\\d+)",
      "aria-label": "Capture",
      spellcheck: false,
      oninput: (e: Event) => (r.capture = (e.target as HTMLInputElement).value),
    });
    const check = (profile.checks ?? []).find((c) => checkIsFor(c, r));
    return h(
      "div",
      { class: "opt", style: "align-items:flex-start" },
      h(
        "div",
        { style: "flex:1;min-width:0" },
        h("div", { class: "row grow" }, h("div", { style: "flex:1" }, folder), h("span", { style: "color:var(--text-3)" }, "→"), h("div", { style: "flex:1.4" }, pattern)),
        h("div", { class: "row", style: "margin-top:6px" }, h("div", { style: "flex:1" }, capture)),
        check ? checkView(check) : null,
      ),
      iconButton("x", "Remove", () => {
        profile.routes.splice(i, 1);
        draw();
      }),
    );
  }

  function checkView(c: RouteCheck) {
    const kind = c.outcome === "ok" ? "ok" : c.outcome === "unchecked" ? "muted" : "warn";
    const misses = c.samples.filter((s) => s.outcome !== "found" && s.outcome !== "reachable");
    return h(
      "div",
      { class: `route-check ${kind}` },
      h("div", null, icon(c.outcome === "ok" ? "check" : c.outcome === "unchecked" ? "globe" : "x", 12), " ", c.outcome === "ok" ? c.message : c.message.split(". ")[0] + "."),
      ...(c.outcome === "ok" ? [] : misses.map((s) => h("div", { class: "mono sample" }, `${s.path.split("/").pop()} → ${s.url}: ${sampleText(s.outcome, s.status)}`))),
    );
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

  function took(next: SiteProfile) {
    profile = structuredClone(next);
    savedShape = editable(profile);
    store.repos = store.repos.map((r) => (r.id === repoId ? { ...r, site: next } : r));
    emit("repos", "preview");
    draw();
  }

  async function redetect(useAi: boolean) {
    m.setBusy(true);
    try {
      took(await api.detectSite(repoId, useAi));
      await actions.loadFolders(repoId);
      const bad = (profile.checks ?? []).filter((c) => c.outcome === "failed" || c.outcome === "mixed");
      toast(
        bad.length ? `Some post URLs do not match the live site: ${bad.map((c) => c.folder).join(", ")}.` : useAi ? "Site structure worked out with AI." : "Site structure read from the config.",
        bad.length ? "error" : "info",
      );
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      m.setBusy(false);
    }
  }

  /** Try the routes on the live site — the ones in the sheet, saved first
   *  if they were edited, so what is checked is what is shown. */
  async function check() {
    m.setBusy(true);
    try {
      if (url.value.trim() !== repo!.publicUrl) await api.updateRepo(repoId, { publicUrl: url.value });
      if (editable(profile) !== savedShape) await api.saveSite(repoId, profile);
      await actions.reloadRepos();
      took(await api.checkSite(repoId));
      await actions.loadFolders(repoId);
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
      // Only an edit makes the profile "edited by hand".
      if (editable(profile) !== savedShape) await api.saveSite(repoId, profile);
      await actions.reloadRepos();
      await actions.loadFolders(repoId);
      emit("preview");
      m.close();
    } catch (e) {
      toast((e as Error).message, "error");
      m.setBusy(false);
    }
  });
  m.foot.append(h("div", { class: "hint", style: "margin-right:auto" }, `Cloned from ${repo.remoteUrl}`), h("button", { class: "btn quiet", type: "button", onclick: () => m.close() }, "Cancel"), save);
  draw();
}
