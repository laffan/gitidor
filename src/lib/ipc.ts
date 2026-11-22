// Every call to the Rust side, typed. Inside Tauri these go through `invoke`;
// in a plain browser (`npm run dev` without Tauri, and the screenshot harness)
// they go to an in-memory mock so the interface can be worked on anywhere.

import { addLog, log, type Incoming } from "./log";
import type {
  Branches,
  CloneProgress,
  CommitInfo,
  DirInfo,
  FileEntry,
  KeyTest,
  PullReport,
  RepoCheck,
  RollbackPlan,
  RepoRecord,
  RepoStatus,
  RepoSummary,
  SecretStatus,
  Settings,
  SiteProfile,
} from "./types";

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type Listen = <T>(event: string, handler: (payload: T) => void) => Promise<() => void>;

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let backend: Promise<{ invoke: Invoke; listen: Listen }> | null = null;

function load() {
  if (!backend) {
    backend = inTauri
      ? Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event")]).then(([core, event]) => ({
          invoke: core.invoke as Invoke,
          listen: (async (name: string, handler: (p: unknown) => void) => event.listen(name, (e) => handler(e.payload))) as Listen,
        }))
      : import("../mock/mock-backend").then((m) => m.mockBackend());
  }
  return backend;
}

// Calls made often enough that timing each one would bury everything else.
const QUIET = new Set(["repo_status", "secret_status", "get_settings", "platform", "site_lookup", "repo_show"]);

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const b = await load();
  const started = performance.now();
  const repoId = typeof args?.id === "string" ? args.id : null;
  try {
    const out = await b.invoke<T>(cmd, args);
    if (!QUIET.has(cmd)) log.debug("ipc", `${cmd}${describeArgs(args)} — ${Math.round(performance.now() - started)} ms`, repoId);
    return out;
  } catch (e) {
    // Commands reject with the Rust `String` error; keep it as an Error.
    const message = typeof e === "string" ? e : ((e as Error)?.message ?? String(e));
    log.error("ipc", message, repoId);
    throw new Error(message);
  }
}

/** The arguments worth showing beside a call's name: paths and names, never
 *  file contents or keys. */
function describeArgs(args?: Record<string, unknown>): string {
  if (!args) return "";
  const shown = ["path", "folder", "branch", "address", "provider", "from", "to"]
    .filter((k) => typeof args[k] === "string" && args[k])
    .map((k) => String(args[k]));
  return shown.length ? ` ${shown.join(" ")}` : "";
}

export const api = {
  platform: () => call<string>("platform"),

  getSettings: () => call<Settings>("get_settings"),
  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),
  secretStatus: () => call<SecretStatus>("secret_status"),
  githubSignIn: (token: string) => call<SecretStatus>("github_sign_in", { token }),
  githubSignOut: () => call<SecretStatus>("github_sign_out"),
  setAiKey: (provider: string, key: string) => call<SecretStatus>("set_ai_key", { provider, key }),
  testAiKey: (provider: string) => call<KeyTest>("test_ai_key", { provider }),

  githubCheckRepo: (address: string) => call<RepoCheck>("github_check_repo", { address }),
  githubListRepos: () => call<RepoSummary[]>("github_list_repos"),

  listRepos: () => call<RepoRecord[]>("list_repos"),
  addRepo: (requestId: string, address: string, publicUrl: string, branch: string) =>
    call<RepoRecord>("add_repo", { requestId, address, publicUrl, branch }),
  removeRepo: (id: string, deleteFiles: boolean) => call<void>("remove_repo", { id, deleteFiles }),
  updateRepo: (id: string, patch: { name?: string; publicUrl?: string }) => call<RepoRecord>("update_repo", { id, patch }),
  reorderRepos: (ids: string[]) => call<void>("reorder_repos", { ids }),

  status: (id: string) => call<RepoStatus>("repo_status", { id }),
  fetch: (id: string) => call<RepoStatus>("repo_fetch", { id }),
  pull: (id: string) => call<PullReport>("repo_pull", { id }),
  commit: (id: string, paths: string[], message: string) => call<RepoStatus>("repo_commit", { id, paths, message }),
  push: (id: string) => call<RepoStatus>("repo_push", { id }),
  branches: (id: string, fetch: boolean) => call<Branches>("repo_branches", { id, fetch }),
  checkout: (id: string, branch: string, create: boolean) => call<RepoStatus>("repo_checkout", { id, branch, create }),
  discard: (id: string, path: string) => call<RepoStatus>("repo_discard", { id, path }),
  diff: (id: string, path: string) => call<string>("repo_diff", { id, path }),
  log: (id: string, limit: number) => call<CommitInfo[]>("repo_log", { id, limit }),
  /** A file as a commit (`HEAD`, `origin/main`, an id) has it; null if it does not. */
  show: (id: string, rev: string, path: string) => call<string | null>("repo_show", { id, rev, path }),
  rollbackPlan: (id: string, to: "local" | "remote") => call<RollbackPlan>("repo_rollback_plan", { id, to }),
  rollback: (id: string, plan: RollbackPlan) => call<RepoStatus>("repo_rollback", { id, to: plan.to, head: plan.head, target: plan.target.id }),

  listDirs: (id: string) => call<DirInfo[]>("list_dirs", { id }),
  setFolders: (id: string, folders: string[]) => call<RepoRecord>("set_folders", { id, folders }),
  listFolder: (id: string, folder: string) => call<FileEntry[]>("list_folder", { id, folder }),
  readFile: (id: string, path: string) => call<string>("read_file", { id, path }),
  writeFile: (id: string, path: string, content: string) => call<void>("write_file", { id, path, content }),
  createFile: (id: string, folder: string, name: string, content: string) =>
    call<string>("create_file", { id, folder, name, content }),
  renameFile: (id: string, from: string, to: string) => call<void>("rename_file", { id, from, to }),
  deleteFile: (id: string, path: string) => call<void>("delete_file", { id, path }),
  importAsset: (id: string, dir: string, name: string, data: string) => call<string>("import_asset", { id, dir, name, data }),

  detectSite: (id: string, useAi: boolean) => call<SiteProfile>("detect_site", { id, useAi }),
  saveSite: (id: string, profile: SiteProfile) => call<RepoRecord>("save_site", { id, profile }),
  siteLookup: (id: string, urlPath: string) => call<string | null>("site_lookup", { id, urlPath }),
};

/** Lines and progress from the Rust side, straight into the console's log. */
export async function listenForLogs(): Promise<() => void> {
  const b = await load();
  return b.listen<Incoming>("log", (e) => addLog(e));
}

export async function onCloneProgress(handler: (p: CloneProgress) => void): Promise<() => void> {
  const b = await load();
  return b.listen<CloneProgress>("clone-progress", handler);
}

export async function openExternal(url: string): Promise<void> {
  if (inTauri) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}
