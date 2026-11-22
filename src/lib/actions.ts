// What happens when somebody does something. The columns call these; these
// call the backend, update the store, and announce what changed.

import { api } from "./ipc";
import { emit, folderKey, knownFile, repoById, store } from "./store";
import type { RepoStatus } from "./types";
import { toast } from "../ui/toast";
import { newPostName, newPostText, todayIso } from "./frontmatter";

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
  if (repos.length) await selectRepo(repos[0].id);
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
  for (const [key, list] of Object.entries(store.files)) {
    if (!key.startsWith(`${id}:`) || !list) continue;
    for (const f of list) f.change = kinds.get(f.path) ?? "";
  }
  emit("status", "files");
}

export async function selectRepo(id: string, opts: { showFiles?: boolean } = {}) {
  const changed = store.activeRepoId !== id;
  store.activeRepoId = id;
  if (opts.showFiles) store.layout.pane = "files";
  store.layout.drawer = false;
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
  await Promise.all(repo.folders.map((f) => loadFolder(repoId, f)));
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
  const updated = await api.setFolders(repoId, folders);
  store.repos = store.repos.map((r) => (r.id === repoId ? updated : r));
  emit("repos");
  await loadFolders(repoId);
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

// ── the open file ───────────────────────────────────────────────────────────

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let statusTimer: ReturnType<typeof setTimeout> | undefined;

export async function openFile(repoId: string, path: string) {
  await flushSave();
  try {
    const text = await api.readFile(repoId, path);
    store.openFile = { repoId, path, saved: text, text, state: "saved", error: null };
    store.layout.pane = "editor";
    emit("file", "layout", "files", "save");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

export function closeFile() {
  void flushSave();
  store.openFile = null;
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
    applyStatus(id, await api.push(id));
    await reloadRepos();
    toast("Pushed to GitHub.");
  });
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
    await loadFolder(repoId, folder);
    await refreshStatus(repoId);
    await openFile(repoId, path);
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

export async function deleteFile(repoId: string, path: string, folder: string) {
  if (store.openFile?.path === path && store.openFile.repoId === repoId) {
    store.openFile = null;
    emit("file", "save");
  }
  try {
    await api.deleteFile(repoId, path);
    await loadFolder(repoId, folder);
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
