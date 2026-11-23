// What happens when somebody does something. The columns call these; these
// call the backend, update the store, and announce what changed.

import { api } from "./ipc";
import { emit, folderKey, knownFile, repoById, store } from "./store";
import type { RepoStatus, RollbackPlan, SiteProfile } from "./types";
import { toast } from "../ui/toast";
import { newPostName, newPostText, todayIso } from "./frontmatter";
import { log } from "./log";
import { splitPublicUrl } from "./site";
import { aiReady, checkFor, routeLabel, unconfirmed } from "./preview-links";

export async function boot() {
  const [platform, settings, secrets, repos] = await Promise.all([
    api.platform().catch(() => ""),
    api.getSettings(),
    api.secretStatus(),
    api.listRepos(),
  ]);
  store.platform = platform;
  store.settings = settings;
  store.secrets = secrets;
  store.repos = repos;
  emit("settings", "secrets", "repos");
  await Promise.all(repos.map((r) => refreshStatus(r.id)));
  // Back where the last session left off: its repository, and its file if
  // that is still there on this branch.
  const last = recall();
  const first = repos.find((r) => r.id === last.repoId) ?? repos[0];
  if (first) await selectRepo(first.id);
  if (last.file && repoById(last.file.repoId)) await openFile(last.file.repoId, last.file.path, { restoring: true });
}

// ── where the last session left off ─────────────────────────────────────────

const LAST_KEY = "gitidor.last";

interface Last {
  repoId: string | null;
  file: { repoId: string; path: string } | null;
}

/** The repository and file open last, on this device. */
function recall(): Last {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_KEY) ?? "null") as Partial<Last> | null;
    return { repoId: typeof saved?.repoId === "string" ? saved.repoId : null, file: saved?.file && typeof saved.file.path === "string" ? saved.file : null };
  } catch {
    return { repoId: null, file: null };
  }
}

function remember() {
  const f = store.openFile;
  const last: Last = { repoId: store.activeRepoId, file: f ? { repoId: f.repoId, path: f.path } : null };
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(last));
  } catch {
    // Private mode or storage turned off: the next launch starts fresh.
  }
}

export async function reloadRepos() {
  store.repos = await api.listRepos();
  emit("repos");
}

export async function refreshStatus(id: string): Promise<RepoStatus | undefined> {
  try {
    const status = await api.status(id);
    applyStatus(id, status);
    return status;
  } catch (e) {
    store.errors[id] = (e as Error).message;
    emit("status");
    return undefined;
  }
}

/** Store a status and carry its change kinds onto the listed files, so the
 *  dots in the Files column move without re-reading the folder. */
function applyStatus(id: string, status: RepoStatus) {
  store.status[id] = status;
  const kinds = new Map(status.changes.map((c) => [c.path, c.kind]));
  for (const listings of [store.files, store.uploads]) {
    for (const [key, list] of Object.entries(listings)) {
      if (!key.startsWith(`${id}:`) || !list) continue;
      for (const f of list) f.change = kinds.get(f.path) ?? "";
    }
  }
  emit("status", "files");
}

export async function selectRepo(id: string, opts: { showFiles?: boolean } = {}) {
  const changed = store.activeRepoId !== id;
  store.activeRepoId = id;
  if (changed && store.viewing && store.viewing.repoId !== id) {
    store.viewing = null;
    emit("viewer");
  }
  if (changed && store.browsing && store.browsing.repoId !== id) closeBrowser();
  if (opts.showFiles) store.layout.pane = "files";
  store.layout.drawer = false;
  remember();
  emit("repos", "layout");
  if (changed) await loadFolders(id);
  const repo = repoById(id);
  if (changed && repo && store.settings.git.fetchOnOpen && store.online) {
    // Quietly: "is there anything new?" never merges and never complains
    // when the network is not there.
    api
      .fetch(id)
      .then((s) => applyStatus(id, s))
      .catch(() => undefined);
  }
}

export async function loadFolders(repoId: string) {
  const repo = repoById(repoId);
  if (!repo) return;
  await Promise.all([...repo.folders.map((f) => loadFolder(repoId, f)), ...(repo.uploadFolders ?? []).map((f) => loadUploads(repoId, f))]);
}

export async function loadUploads(repoId: string, folder: string) {
  try {
    store.uploads[folderKey(repoId, folder)] = await api.listUploads(repoId, folder);
  } catch (e) {
    store.uploads[folderKey(repoId, folder)] = [];
    toast((e as Error).message, "error");
  }
  emit("files");
}

export async function loadFolder(repoId: string, folder: string) {
  try {
    store.files[folderKey(repoId, folder)] = await api.listFolder(repoId, folder);
  } catch (e) {
    store.files[folderKey(repoId, folder)] = [];
    toast((e as Error).message, "error");
  }
  emit("files");
}

export async function setFolders(repoId: string, folders: string[]) {
  const before = repoById(repoId)?.folders ?? [];
  const updated = await api.setFolders(repoId, folders);
  log.info("files", folders.length ? `Folders: ${updated.folders.join(", ")}` : "No folders chosen", repoId);
  store.repos = store.repos.map((r) => (r.id === repoId ? updated : r));
  emit("repos");
  await loadFolders(repoId);
  // New content folders: make sure the preview can find their posts.
  const added = updated.folders.filter((f) => !before.includes(f));
  if (added.length) void assessPreviewLinks(repoId, added);
}

function setSite(repoId: string, site: SiteProfile) {
  store.repos = store.repos.map((r) => (r.id === repoId ? { ...r, site } : r));
  emit("repos", "preview");
}

/**
 * Make sure the live preview can open these folders' posts and name the post
 * behind a page. Their routes are tried on the live site first; any the site
 * does not confirm are worked out by the AI provider, when one is set up — a
 * one-time assessment per folder, since a confirmed route is not asked about
 * again. A profile edited by hand is checked but never replaced.
 *
 * `force` (the repository's menu) always asks the AI, for every folder.
 */
export async function assessPreviewLinks(repoId: string, folders: string[], force = false): Promise<void> {
  const repo = repoById(repoId);
  if (!repo || !folders.length) return;
  const ai = aiReady();
  if (force && !ai) {
    toast("Set up an AI provider under Settings → AI first.", "error");
    return;
  }
  const canCheck = !!splitPublicUrl(repo.publicUrl) && store.online;
  await gitStep(repoId, force ? "Working out preview links with AI…" : "Checking preview links on the live site…", async () => {
    let profile = repo.site;
    if (!force && canCheck) {
      profile = await api.checkSite(repoId);
      setSite(repoId, profile);
    }
    const open = force ? folders : unconfirmed(profile, folders);
    if (!open.length) {
      log.info("preview", `Preview links confirmed on the live site for ${folders.join(", ")}`, repoId);
      return;
    }
    const failed = open.map((f) => checkFor(profile, f)).filter((c) => c && (c.outcome === "failed" || c.outcome === "mixed"));
    if (!force && (!ai || !store.online || profile?.source === "manual")) {
      // Nothing more to do here; say so only when the site said no.
      if (failed.length) {
        const how = profile?.source === "manual" ? "Edit them in the repository's settings, or ask AI from its ⋯ menu." : ai ? "Ask AI from the repository's ⋯ menu when online." : "Set up AI under Settings → AI to work them out, or edit them in the repository's settings.";
        toast(`Preview links for ${failed.map((c) => c!.folder).join(", ")} do not match the live site. ${how}`, "error", 10000);
      }
      return;
    }
    store.busy[repoId] = "Working out preview links with AI…";
    emit("status");
    profile = await api.detectSite(repoId, true);
    setSite(repoId, profile);
    await loadFolders(repoId);
    toast(...assessmentSummary(profile, folders));
  });
}

/** What the AI pass came to, for a toast. */
function assessmentSummary(profile: SiteProfile, folders: string[]): [string, "info" | "error", number] {
  const checks = folders.map((f) => checkFor(profile, f)).filter((c) => !!c);
  const bad = checks.filter((c) => c.outcome === "failed" || c.outcome === "mixed");
  if (bad.length) return [`AI's preview links still miss posts on the live site: ${bad.map((c) => `${routeLabel(c)} — ${c.message}`).join(" ")} The routes can be edited in the repository's settings.`, "error", 12000];
  const ok = checks.filter((c) => c.outcome === "ok");
  if (ok.length && ok.length === checks.length) return [`Preview links worked out with AI and confirmed on the live site: ${ok.map(routeLabel).join(", ")}.`, "info", 7000];
  const routes = profile.routes.filter((r) => folders.includes(r.folder)).map((r) => `${r.folder} → ${r.pattern}`);
  return [`Preview links worked out with AI${routes.length ? `: ${routes.join(", ")}` : ""}. The live site could not confirm them yet.`, "info", 7000];
}

export async function removeFolder(repoId: string, folder: string) {
  const repo = repoById(repoId);
  if (!repo) return;
  delete store.files[folderKey(repoId, folder)];
  await setFolders(
    repoId,
    repo.folders.filter((f) => f !== folder),
  );
}

export async function setUploadFolders(repoId: string, folders: string[]) {
  const updated = await api.setUploadFolders(repoId, folders);
  log.info("files", folders.length ? `Upload folders: ${updated.uploadFolders.join(", ")}` : "No upload folders", repoId);
  store.repos = store.repos.map((r) => (r.id === repoId ? updated : r));
  emit("repos");
  await loadFolders(repoId);
}

export async function removeUploadFolder(repoId: string, folder: string) {
  const repo = repoById(repoId);
  if (!repo) return;
  delete store.uploads[folderKey(repoId, folder)];
  await setUploadFolders(
    repoId,
    repo.uploadFolders.filter((f) => f !== folder),
  );
}

/** A file's bytes as base64, for `import_asset`. */
export function readBase64(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** GitHub refuses a push with a file over 100 MB in it. */
const MAX_UPLOAD = 100 * 1024 * 1024;

/**
 * Copy files into an upload folder, one at a time. A name already there gets
 * a number added rather than replacing the file. They are new files in the
 * repository: committing and pushing puts them on the site.
 */
export async function uploadFiles(repoId: string, folder: string, files: File[]) {
  const key = folderKey(repoId, folder);
  if (!files.length || store.uploading[key]) return;
  const tooBig = files.filter((f) => f.size > MAX_UPLOAD);
  const sending = files.filter((f) => f.size <= MAX_UPLOAD);
  if (tooBig.length) toast(`${tooBig.map((f) => f.name).join(", ")} ${tooBig.length === 1 ? "is" : "are"} over 100 MB, which GitHub refuses, so ${tooBig.length === 1 ? "it was" : "they were"} left out.`, "error", 9000);
  const saved: string[] = [];
  try {
    for (const [i, file] of sending.entries()) {
      store.uploading[key] = `Uploading ${sending.length > 1 ? `${i + 1} of ${sending.length}` : file.name}…`;
      emit("files");
      try {
        const path = await api.importAsset(repoId, folder, file.name, await readBase64(file));
        saved.push(path);
        log.info("files", `Uploaded ${path} (${size(file.size)})`, repoId);
      } catch (e) {
        toast(`${file.name}: ${(e as Error).message}`, "error");
      }
    }
  } finally {
    store.uploading[key] = undefined;
  }
  await loadUploads(repoId, folder);
  await refreshStatus(repoId);
  if (saved.length) toast(`Uploaded ${saved.length === 1 ? (saved[0].split("/").pop() ?? saved[0]) : `${saved.length} files`} to ${folder}. Commit and push to put ${saved.length === 1 ? "it" : "them"} on the site.`);
}

export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

// ── the open file ───────────────────────────────────────────────────────────

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let statusTimer: ReturnType<typeof setTimeout> | undefined;

/** Show a picture, video or sound from an upload folder in the editor column. */
export function viewUpload(repoId: string, folder: string, path: string) {
  closeBrowser();
  store.viewing = { repoId, folder, path };
  store.layout.pane = "editor";
  emit("viewer", "layout", "files");
}

/** Back to the post (or the empty editor) from an upload. */
export function closeViewer() {
  if (!store.viewing) return;
  store.viewing = null;
  emit("viewer", "files");
}

/** Show the repository's published site in the editor column, from its home
 *  page. The open post stays open underneath. */
export function browseSite(repoId: string) {
  closeViewer();
  store.browsing = { repoId };
  store.siteHit = null;
  store.layout.pane = "editor";
  emit("browser", "layout");
}

/** Back to the post (or the empty editor) from the site. */
export function closeBrowser() {
  if (!store.browsing) return;
  store.browsing = null;
  store.siteHit = null;
  emit("browser");
}

/** The site browser reached a page; `file` is the one it was built from, if
 *  the site profile can name one. Its folder opens, so the Files column can
 *  show it. */
export function siteReached(file: { repoId: string; path: string } | null) {
  if (!store.browsing) return;
  store.siteHit = file;
  if (file) {
    for (const folder of repoById(file.repoId)?.folders ?? []) {
      if (file.path.startsWith(`${folder}/`)) store.collapsed.delete(folderKey(file.repoId, folder));
    }
  }
  emit("browser");
}

/** `restoring`: reopening the last session's file at launch, which says
 *  nothing if the file has gone since. */
export async function openFile(repoId: string, path: string, opts: { restoring?: boolean } = {}) {
  await flushSave();
  try {
    const text = await api.readFile(repoId, path);
    log.debug("files", `${opts.restoring ? "Reopened" : "Opened"} ${path}`, repoId);
    store.openFile = { repoId, path, saved: text, text, state: "saved", error: null };
    store.layout.pane = "editor";
    store.viewing = null;
    store.browsing = null;
    store.siteHit = null;
    remember();
    emit("file", "layout", "files", "save", "viewer", "browser");
  } catch (e) {
    if (opts.restoring) {
      log.debug("files", `Last session's ${path} is not there any more`, repoId);
      remember();
    } else toast((e as Error).message, "error");
  }
}

export function closeFile() {
  void flushSave();
  store.openFile = null;
  remember();
  emit("file", "files", "save");
}

/** The editor's text changed. Saved after a pause, never on every key. */
export function editText(text: string) {
  const f = store.openFile;
  if (!f) return;
  f.text = text;
  if (f.state !== "editing") {
    f.state = "editing";
    emit("save");
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushSave(), Math.max(250, store.settings.autosaveMs || 800));
}

export async function flushSave() {
  clearTimeout(saveTimer);
  const f = store.openFile;
  if (!f || f.text === f.saved) {
    if (f && f.state === "editing") {
      f.state = "saved";
      emit("save");
    }
    return;
  }
  const text = f.text;
  f.state = "saving";
  emit("save");
  try {
    await api.writeFile(f.repoId, f.path, text);
    log.debug("files", `Saved ${f.path} (${(new Blob([text]).size / 1024).toFixed(1)} KB)`, f.repoId);
    f.saved = text;
    f.state = f.text === text ? "saved" : "editing";
    f.error = null;
    emit("save");
    // Status after a pause too: typing should not run `git status` per save.
    clearTimeout(statusTimer);
    const id = f.repoId;
    statusTimer = setTimeout(() => void refreshStatus(id), 600);
  } catch (e) {
    f.state = "error";
    f.error = (e as Error).message;
    log.error("files", `Could not save ${f.path}: ${f.error}`, f.repoId);
    emit("save");
  }
}

// ── git ─────────────────────────────────────────────────────────────────────

/** Run a git step with the card showing what is happening, and the error on
 *  the card if it fails. Answers whether it worked. */
export async function gitStep(id: string, label: string, work: () => Promise<void>): Promise<boolean> {
  if (store.busy[id]) return false;
  await flushSave();
  store.busy[id] = label;
  store.errors[id] = undefined;
  emit("status");
  try {
    await work();
    return true;
  } catch (e) {
    store.errors[id] = (e as Error).message;
    log.warn("app", `${label.replace(/…$/, "")} stopped: ${(e as Error).message}`, id);
    return false;
  } finally {
    store.busy[id] = undefined;
    emit("status");
  }
}

export async function fetchRepo(id: string) {
  await gitStep(id, "Checking GitHub…", async () => {
    applyStatus(id, await api.fetch(id));
    await reloadRepos();
  });
}

export async function pull(id: string) {
  const ok = await gitStep(id, "Pulling…", async () => {
    const report = await api.pull(id);
    applyStatus(id, report.status);
    const o = report.outcome;
    toast(
      o.kind === "upToDate"
        ? "Already up to date."
        : o.kind === "noUpstream"
          ? "This branch is not on GitHub yet — push it first."
          : `Pulled ${o.commits} commit${o.commits === 1 ? "" : "s"}${o.kind === "merged" ? " and merged" : ""}.`,
    );
  });
  if (ok) {
    await loadFolders(id);
    await reloadOpenFile(id);
  }
}

export async function push(id: string) {
  await gitStep(id, "Pushing…", async () => {
    const previous = await pushedFrom(id);
    applyStatus(id, await api.push(id));
    store.pushed[id] = { at: Date.now(), previous };
    await reloadRepos();
    toast("Pushed to GitHub.");
    emit("preview");
  });
}

/** The posts a push is about to send, as GitHub has them now, so the live
 *  preview can tell afterwards whether the site shows the new version yet. */
async function pushedFrom(id: string): Promise<Map<string, string | null>> {
  const status = store.status[id];
  const out = new Map<string, string | null>();
  if (!status?.hasUpstream) return out;
  const posts = status.unpushed.filter((p) => /\.(md|markdown|mdx)$/i.test(p)).slice(0, 40);
  await Promise.all(
    posts.map(async (p) => {
      out.set(p, await api.show(id, `origin/${status.branch}`, p).catch(() => null));
    }),
  );
  return out;
}

/** Roll back as `plan` says; the sheet showed the person what goes. */
export async function rollback(id: string, plan: RollbackPlan): Promise<boolean> {
  const ok = await gitStep(id, "Rolling back…", async () => {
    applyStatus(id, await api.rollback(id, plan));
    log.info("git", `Rolled back to ${plan.target.short}: ${plan.commits.length} commit${plan.commits.length === 1 ? "" : "s"} and ${plan.files.length} file${plan.files.length === 1 ? "" : "s"} of changes dropped`, id);
  });
  if (ok) {
    await loadFolders(id);
    await reloadOpenFile(id);
    toast(`Rolled back to ${plan.target.short} “${plan.target.summary}”.`);
  }
  return ok;
}

export async function commit(id: string, paths: string[], message: string, andPush: boolean): Promise<boolean> {
  const ok = await gitStep(id, "Committing…", async () => {
    applyStatus(id, await api.commit(id, paths, message));
  });
  if (ok && andPush) await push(id);
  else if (ok) toast("Committed. Push when you are ready.");
  return ok;
}

export async function checkout(id: string, branch: string, create: boolean) {
  const ok = await gitStep(id, create ? `Creating ${branch}…` : `Switching to ${branch}…`, async () => {
    applyStatus(id, await api.checkout(id, branch, create));
  });
  if (ok) {
    await loadFolders(id);
    await reloadOpenFile(id);
  }
}

export async function discard(id: string, path: string) {
  await gitStep(id, "Discarding…", async () => {
    applyStatus(id, await api.discard(id, path));
  });
  await loadFolders(id);
  await reloadOpenFile(id, path);
}

/** After a pull, branch switch or discard the open file may have changed on
 *  disk; take the disk's version when nothing here is unsaved. */
async function reloadOpenFile(repoId: string, onlyPath?: string) {
  const f = store.openFile;
  if (!f || f.repoId !== repoId || (onlyPath && f.path !== onlyPath)) return;
  try {
    const text = await api.readFile(repoId, f.path);
    if (text !== f.saved && f.text === f.saved) {
      f.saved = text;
      f.text = text;
      emit("file", "save");
    }
  } catch {
    // Gone on this branch: close it rather than offer to save it back.
    store.openFile = null;
    emit("file", "save");
  }
}

export function commitMessage(paths: string[]): string {
  const names = paths.map((p) => {
    const f = knownFile(store.activeRepoId ?? "", p);
    return f?.title && f.title.length < 48 ? f.title : (p.split("/").pop() ?? p);
  });
  const shown = names.length <= 3 ? names.join(", ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
  return (store.settings.git.commitTemplate || "Update {files}").replace("{files}", shown);
}

// ── posts ───────────────────────────────────────────────────────────────────

export async function createPost(repoId: string, folder: string, title: string) {
  const list = store.files[folderKey(repoId, folder)] ?? [];
  // The newest post is the template: its frontmatter keys, its format.
  const newest = list.find((f) => f.path.split("/").length === folder.split("/").length + 1) ?? list[0];
  let sample: string | null = null;
  if (newest) sample = await api.readFile(repoId, newest.path).catch(() => null);
  const date = todayIso();
  const siblings = list.filter((f) => f.path.startsWith(`${folder}/`) && !f.path.slice(folder.length + 1).includes("/")).map((f) => f.name);
  const name = newPostName(siblings, title, date);
  const text = newPostText(sample, title, date);
  try {
    const path = await api.createFile(repoId, folder, name, text);
    log.info("files", `Created ${path}`, repoId);
    await loadFolder(repoId, folder);
    await refreshStatus(repoId);
    await openFile(repoId, path);
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

export async function deleteFile(repoId: string, path: string, folder: string, kind: "content" | "upload" = "content") {
  if (store.openFile?.path === path && store.openFile.repoId === repoId) {
    store.openFile = null;
    emit("file", "save");
  }
  try {
    await api.deleteFile(repoId, path);
    log.info("files", `Deleted ${path}`, repoId);
    await (kind === "upload" ? loadUploads(repoId, folder) : loadFolder(repoId, folder));
    await refreshStatus(repoId);
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

export async function saveSettings() {
  emit("settings");
  try {
    await api.saveSettings(store.settings);
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

export function setLayout(patch: Partial<typeof store.layout>) {
  Object.assign(store.layout, patch);
  emit("layout");
}
