// An in-memory stand-in for the Rust side, used when the interface runs in a
// plain browser: `npm run dev` without Tauri, and the screenshot script. It
// answers every command with plausible data shaped like a real Eleventy blog,
// so the columns, sheets and editor can be worked on anywhere.
//
// URL parameters: `?empty` starts with no repositories; `?platform=ios`
// pretends to be an iPad.

import { parseFrontmatter } from "../lib/frontmatter";
import { setMockAssetUrl } from "../ui/asset-url";
import type { Change, RepoRecord, SecretStatus, Settings, SiteProfile } from "../lib/types";
import { defaultSettings } from "../lib/store";

type Handler = (args: Record<string, unknown>) => unknown;

const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");

const profile: SiteProfile = {
  generator: "eleventy",
  source: "heuristic",
  routes: [
    { folder: "posts", pattern: "/blog/{fileSlug}/" },
    { folder: "public", pattern: "/public/{path}/" },
  ],
  assets: [
    { urlPrefix: "/images/blog/", repoPath: "public/blog-images/" },
    { urlPrefix: "/images/essays/", repoPath: "public/essay-thumbnails/" },
    { urlPrefix: "/public/", repoPath: "public/" },
    { urlPrefix: "/", repoPath: "" },
  ],
  stylesheets: ["styles/main.css", "styles/post.css"],
  suggestedFolders: ["posts", "public"],
  publicUrlHint: "https://blog.natelaffan.com/",
  notes: "",
};

const posts: Record<string, string> = {
  "posts/2026-11-02--marettimo.md": `---
title: Marettimo
date: 2026-11-02
summary: An island at the end of the ferry line
tags: [travel]
---
The ferry from Trapani takes an hour and a half, and for the last twenty minutes the island sits on the horizon like a sleeping animal.

![The harbour at dusk | wide](/images/blog/marettimo-harbour.jpg)

We arrived with no plan beyond the walk to the lighthouse. The **path** climbs out of the village past a chapel and then simply *keeps going*, switchback after switchback, until the sea is something you look down on rather than out at.

## The lighthouse

There is a bench at the top. Someone has carved ==a date== into it that is older than both of us.
`,
  "posts/2026-09-14--lisboa.md": `---
title: Lisboa
date: 2026-09-14
summary: Trams, tiles and the long way up
---
Every street in Lisbon is uphill, including, somehow, the ones that go down.

![](/images/blog/lisboa-tram.jpg) ![](/images/blog/lisboa-tiles.jpg)
`,
  "posts/2025-03-03--ode-to-obsession.md": `---
title: Ode to Obsession
date: 2025-03-03
summary: On the projects that will not let go
essay: true
---
Some ideas arrive like weather. You do not decide to have them; you decide what to do while they last.
`,
  "posts/2024-12-30--thrum.md": `---
title: Thrum
date: 2024-12-30
---
The refrigerator, the furnace, the far-off highway. A house is never as quiet as it looks.
`,
  "posts/2010-03-14--crickets.md": `---
title: Crickets
date: 2010-03-14
summary: A record worth staying up for
imagePost: true
---
![](/images/blog/crickets-1.jpg) ![](/images/blog/crickets-2.jpg) ![](/images/blog/crickets-3.jpg)
`,
  "posts/2009-12-31--my-tribe.md": `---
title: My Tribe
date: 2009-12-31
---
![my tribe | floatRight](/images/blog/my-tribe.jpg)

New Year's Eve, and the table is full.
`,
  "public/about.md": `---
title: About
permalink: /about/
---
# About

Notes, essays and the occasional photograph.
`,
};

const head: Record<string, string> = { ...posts };
// One edit already in progress, so the card and the files show a change.
posts["posts/2026-11-02--marettimo.md"] = posts["posts/2026-11-02--marettimo.md"].replace("bench at the top", "worn bench at the top");

const blog: RepoRecord = {
  id: "blog01",
  name: "blog.natelaffan.com",
  owner: "laffan",
  repo: "blog.natelaffan.com",
  remoteUrl: "https://github.com/laffan/blog.natelaffan.com.git",
  publicUrl: "https://blog.natelaffan.com/",
  folders: ["posts"],
  site: profile,
  addedAt: Date.now() - 86400000 * 12,
  lastFetched: Date.now() - 60000 * 14,
  lastPushed: Date.now() - 86400000 * 2,
};

const notes: RepoRecord = {
  id: "notes02",
  name: "garden-notes",
  owner: "laffan",
  repo: "garden-notes",
  remoteUrl: "https://github.com/laffan/garden-notes.git",
  publicUrl: "https://laffan.github.io/garden-notes/",
  folders: ["content/notes"],
  site: { ...profile, generator: "hugo", routes: [{ folder: "content/notes", pattern: "/notes/{path}/" }], assets: [{ urlPrefix: "/", repoPath: "static/" }], stylesheets: [] },
  addedAt: Date.now() - 86400000 * 40,
  lastFetched: Date.now() - 86400000,
  lastPushed: Date.now() - 86400000 * 9,
};

const files: Record<string, Record<string, string>> = {
  blog01: posts,
  notes02: {
    "content/notes/compost.md": "+++\ntitle = 'Compost'\ndate = 2026-10-01\n+++\n\nTurn it every two weeks.\n",
    "content/notes/tomatoes.md": "+++\ntitle = 'Tomatoes'\ndate = 2026-08-12\ndraft = true\n+++\n\nToo many again.\n",
  },
};
const heads: Record<string, Record<string, string>> = { blog01: head, notes02: { ...files.notes02 } };
const meta: Record<string, { branch: string; ahead: number; behind: number; branches: string[]; remote: string[]; log: { summary: string; time: number }[] }> = {
  blog01: { branch: "main", ahead: 0, behind: 2, branches: ["main"], remote: ["drafts"], log: [{ summary: "Add Lisboa", time: Date.now() - 86400000 * 2 }] },
  notes02: { branch: "main", ahead: 1, behind: 0, branches: ["main", "spring"], remote: [], log: [{ summary: "Tomato notes", time: Date.now() - 86400000 * 3 }] },
};

let repos: RepoRecord[] = params.has("empty") ? [] : [blog, notes];
let settings: Settings = structuredClone(defaultSettings);
let secrets: SecretStatus = { githubLogin: "laffan", hasGithubToken: true, hasAnthropicKey: true, hasOpenaiKey: false };
if (params.has("empty")) secrets = { githubLogin: "", hasGithubToken: false, hasAnthropicKey: false, hasOpenaiKey: false };
settings.ai.provider = "anthropic";

const progressListeners = new Set<(p: unknown) => void>();

function changes(id: string): Change[] {
  const f = files[id] ?? {};
  const h = heads[id] ?? {};
  const out: Change[] = [];
  for (const p of new Set([...Object.keys(f), ...Object.keys(h)])) {
    if (!(p in h)) out.push({ path: p, kind: "added" });
    else if (!(p in f)) out.push({ path: p, kind: "deleted" });
    else if (f[p] !== h[p]) out.push({ path: p, kind: "modified" });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function status(id: string) {
  const m = meta[id];
  const last = m.log[0];
  return {
    branch: m.branch,
    head: last ? { id: "a1b2c3d4e5", short: "a1b2c3d", summary: last.summary, author: "laffan", time: last.time } : null,
    ahead: m.ahead,
    behind: m.behind,
    hasUpstream: true,
    changes: changes(id),
  };
}

function fileSlug(stem: string) {
  return /^\d{4}-\d{2}-\d{2}-/.test(stem) ? stem.slice(11) : stem;
}

function urlFor(repo: RepoRecord, path: string, text: string): string | null {
  const fm = parseFrontmatter(text);
  if (fm?.data.draft === true) return null;
  if (typeof fm?.data.permalink === "string") return fm.data.permalink;
  const route = repo.site?.routes.find((r) => path.startsWith(`${r.folder}/`));
  if (!route) return null;
  const within = path.slice(route.folder.length + 1).replace(/\.(md|markdown)$/, "");
  const stem = within.split("/").pop() ?? within;
  return route.pattern.replace("{fileSlug}", fileSlug(stem)).replace("{path}", within).replace("{slug}", fileSlug(stem));
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const handlers: Record<string, Handler> = {
  platform: () => params.get("platform") ?? "macos",
  get_settings: () => structuredClone(settings),
  save_settings: (a) => void (settings = a.settings as Settings),
  secret_status: () => ({ ...secrets }),
  github_sign_in: (a) => {
    if (!String(a.token).trim()) throw "Paste a token first";
    secrets = { ...secrets, githubLogin: "laffan", hasGithubToken: true };
    return { ...secrets };
  },
  github_sign_out: () => ((secrets = { ...secrets, githubLogin: "", hasGithubToken: false }), { ...secrets }),
  set_ai_key: (a) => {
    const has = !!String(a.key).trim();
    secrets = a.provider === "anthropic" ? { ...secrets, hasAnthropicKey: has } : { ...secrets, hasOpenaiKey: has };
    return { ...secrets };
  },
  test_ai_key: async (a) => {
    await delay(400);
    return a.provider === "anthropic"
      ? { models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"], message: "Key works — 4 models available." }
      : { models: ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6-luna"], message: "Key works — 3 models available." };
  },
  github_check_repo: async (a) => {
    await delay(500);
    const [owner, repo] = String(a.address).replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "").split("/");
    if (!owner || !repo) throw "Enter a repository address";
    return {
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
      owner,
      repo,
      fullName: `${owner}/${repo}`,
      description: "Eleventy blog",
      private: false,
      canPush: true,
      defaultBranch: "main",
      branches: ["drafts", "gh-pages", "main"],
      pagesUrl: `https://${repo.includes(".") ? repo : `${owner}.github.io/${repo}`}/`,
      pagesConfirmed: true,
      signedIn: secrets.hasGithubToken,
    };
  },
  github_list_repos: () => [
    { fullName: "laffan/blog.natelaffan.com", private: false, canPush: true, defaultBranch: "main", description: "11ty blog" },
    { fullName: "laffan/garden-notes", private: true, canPush: true, defaultBranch: "main", description: "Hugo notes" },
    { fullName: "laffan/hush", private: false, canPush: true, defaultBranch: "main", description: "A quiet text editor" },
  ],
  list_repos: () => structuredClone(repos),
  add_repo: async (a) => {
    const total = 1840;
    for (let i = 0; i <= total; i += 230) {
      await delay(120);
      progressListeners.forEach((fn) => fn({ requestId: a.requestId, received: Math.min(i, total), total, bytes: i * 4100 }));
    }
    const [owner, name] = String(a.address).replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "").split("/");
    const id = `r${Math.random().toString(36).slice(2, 8)}`;
    const record: RepoRecord = { ...blog, id, name, owner, repo: name, folders: [], publicUrl: String(a.publicUrl) || blog.publicUrl, addedAt: Date.now() };
    files[id] = { ...posts };
    heads[id] = { ...posts };
    meta[id] = { branch: "main", ahead: 0, behind: 0, branches: ["main"], remote: [], log: [{ summary: "Initial commit", time: Date.now() - 3600000 }] };
    repos.push(record);
    return record;
  },
  remove_repo: (a) => void (repos = repos.filter((r) => r.id !== a.id)),
  update_repo: (a) => {
    const patch = a.patch as { name?: string; publicUrl?: string };
    repos = repos.map((r) => (r.id === a.id ? { ...r, ...(patch.name ? { name: patch.name } : {}), ...(patch.publicUrl !== undefined ? { publicUrl: patch.publicUrl } : {}) } : r));
    return repos.find((r) => r.id === a.id);
  },
  reorder_repos: () => undefined,
  repo_status: (a) => status(String(a.id)),
  repo_fetch: async (a) => (await delay(300), status(String(a.id))),
  repo_pull: async (a) => {
    await delay(500);
    const m = meta[String(a.id)];
    const commits = m.behind;
    m.behind = 0;
    return { outcome: commits ? { kind: "fastForward", commits } : { kind: "upToDate" }, status: status(String(a.id)) };
  },
  repo_commit: async (a) => {
    await delay(250);
    const id = String(a.id);
    for (const p of a.paths as string[]) {
      if (p in files[id]) heads[id][p] = files[id][p];
      else delete heads[id][p];
    }
    meta[id].ahead++;
    meta[id].log.unshift({ summary: String(a.message), time: Date.now() });
    return status(id);
  },
  repo_push: async (a) => {
    await delay(600);
    meta[String(a.id)].ahead = 0;
    return status(String(a.id));
  },
  repo_branches: (a) => {
    const m = meta[String(a.id)];
    return { current: m.branch, local: m.branches, remoteOnly: m.remote };
  },
  repo_checkout: (a) => {
    const m = meta[String(a.id)];
    const b = String(a.branch);
    if (!m.branches.includes(b)) m.branches.push(b);
    m.remote = m.remote.filter((r) => r !== b);
    m.branch = b;
    return status(String(a.id));
  },
  repo_discard: (a) => {
    const id = String(a.id);
    const p = String(a.path);
    if (p in heads[id]) files[id][p] = heads[id][p];
    else delete files[id][p];
    return status(id);
  },
  repo_diff: (a) => {
    const id = String(a.id);
    const p = String(a.path);
    const before = (heads[id][p] ?? "").split("\n");
    const after = (files[id][p] ?? "").split("\n");
    const out = [`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`, "@@ changes @@"];
    const n = Math.max(before.length, after.length);
    for (let i = 0; i < n; i++) {
      if (before[i] === after[i]) {
        if (before[i] !== undefined && (after[i - 1] !== before[i - 1] || after[i + 1] !== before[i + 1])) out.push(` ${before[i]}`);
      } else {
        if (before[i] !== undefined) out.push(`-${before[i]}`);
        if (after[i] !== undefined) out.push(`+${after[i]}`);
      }
    }
    return out.join("\n");
  },
  repo_log: (a) => meta[String(a.id)].log.map((l, i) => ({ id: `${i}`, short: `abc${i}`, summary: l.summary, author: "laffan", time: l.time })),
  list_dirs: (a) => {
    const id = String(a.id);
    const counts = new Map<string, number>();
    for (const p of Object.keys(files[id] ?? {})) {
      const dir = p.split("/").slice(0, -1).join("/");
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
    const extra = ["_includes", "_includes/partials", "public/blog-images", "public/essay-thumbnails", "scripts", "styles", "_data", "content", "static"];
    const all = new Set([...counts.keys(), ...extra].filter(Boolean));
    return [...all].sort().map((path) => ({ path, depth: path.split("/").length, markdown: counts.get(path) ?? 0, markdownTotal: [...counts.entries()].filter(([d]) => d === path || d.startsWith(`${path}/`)).reduce((s, [, n]) => s + n, 0) }));
  },
  set_folders: (a) => {
    repos = repos.map((r) => (r.id === a.id ? { ...r, folders: a.folders as string[] } : r));
    return repos.find((r) => r.id === a.id);
  },
  list_folder: (a) => {
    const id = String(a.id);
    const folder = String(a.folder);
    const repo = repos.find((r) => r.id === id)!;
    const kinds = new Map(changes(id).map((c) => [c.path, c.kind]));
    return Object.entries(files[id] ?? {})
      .filter(([p]) => p.startsWith(`${folder}/`))
      .map(([path, text]) => {
        const fm = parseFrontmatter(text);
        const name = path.split("/").pop()!;
        const d = fm?.data.date;
        const date = d instanceof Date ? d.toISOString().slice(0, 10) : typeof d === "string" ? d.slice(0, 10) : (/^\d{4}-\d{2}-\d{2}/.exec(name)?.[0] ?? "");
        return {
          path,
          name,
          title: typeof fm?.data.title === "string" ? fm.data.title : name,
          date,
          draft: fm?.data.draft === true,
          url: urlFor(repo, path, text),
          change: kinds.get(path) ?? "",
          modified: Date.now(),
        };
      })
      .sort((x, y) => y.date.localeCompare(x.date) || y.name.localeCompare(x.name));
  },
  read_file: (a) => {
    const t = files[String(a.id)]?.[String(a.path)];
    if (t === undefined) throw `Cannot open ${a.path}`;
    return t;
  },
  write_file: (a) => void (files[String(a.id)][String(a.path)] = String(a.content)),
  create_file: (a) => {
    const path = `${a.folder}/${a.name}`;
    if (path in files[String(a.id)]) throw `${path} already exists`;
    files[String(a.id)][path] = String(a.content);
    return path;
  },
  rename_file: () => undefined,
  delete_file: (a) => void delete files[String(a.id)][String(a.path)],
  import_asset: (a) => `${a.dir}/${a.name}`,
  detect_site: async () => (await delay(900), { ...profile, source: "ai", notes: "Eleventy copies public/blog-images to /images/blog/; posts use the folder data file's permalink." }),
  save_site: (a) => {
    repos = repos.map((r) => (r.id === a.id ? { ...r, site: a.profile as SiteProfile } : r));
    return repos.find((r) => r.id === a.id);
  },
  site_lookup: (a) => {
    const id = String(a.id);
    const repo = repos.find((r) => r.id === id)!;
    const want = String(a.urlPath).replace(/\/+$/, "");
    for (const [path, text] of Object.entries(files[id] ?? {})) {
      if ((urlFor(repo, path, text) ?? "").replace(/\/+$/, "") === want) return path;
    }
    return null;
  },
};

// Stand-in pictures: a soft gradient per file name, with the name on it.
function placeholder(path: string): string {
  let hash = 0;
  for (const c of path) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const name = path.split("/").pop() ?? path;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,72%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360},40%,48%)"/></linearGradient></defs><rect width="1200" height="760" fill="url(#g)"/><text x="40" y="720" font-family="system-ui" font-size="30" fill="rgba(255,255,255,.85)">${name}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function mockBackend() {
  setMockAssetUrl((_id, path) => (/\.(jpe?g|png|gif|webp|avif|svg)$/i.test(path) ? placeholder(path) : `about:blank#${path}`));
  return {
    invoke: async <T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> => {
      const fn = handlers[cmd];
      if (!fn) throw `mock: no handler for ${cmd}`;
      await delay(20);
      return (await fn(args)) as T;
    },
    listen: async <T>(event: string, handler: (payload: T) => void) => {
      if (event !== "clone-progress") return () => undefined;
      const fn = handler as (p: unknown) => void;
      progressListeners.add(fn);
      return () => progressListeners.delete(fn);
    },
  };
}
