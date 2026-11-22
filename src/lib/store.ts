// What the interface is showing, in one place, and a way to hear when a part
// of it changes. Columns subscribe to the topics they draw; actions change
// the store and announce which topics moved.

import type { FileEntry, RepoRecord, RepoStatus, SecretStatus, Settings, UploadEntry } from "./types";

export type Topic = "repos" | "status" | "files" | "file" | "settings" | "secrets" | "layout" | "preview" | "save" | "log" | "console";

export interface OpenFile {
  repoId: string;
  path: string;
  /** What is on disk, as far as this app knows. */
  saved: string;
  /** What is in the editor. */
  text: string;
  state: "saved" | "editing" | "saving" | "error";
  error: string | null;
}

export type Pane = "repos" | "files" | "editor";

export const defaultSettings: Settings = {
  appearance: {
    theme: "system",
    font: "plex-mono",
    customFont: "",
    fontSize: 17,
    lineHeight: 1.65,
    columnWidth: 66,
    frontmatter: "dim",
    inlineImages: true,
    spellcheck: true,
    nightVision: false,
  },
  git: { authorName: "", authorEmail: "", commitTemplate: "Update {files}", fetchOnOpen: true, pushAfterCommit: true },
  ai: { provider: "none", anthropicModel: "claude-opus-5-5", openaiModel: "" },
  autosaveMs: 800,
};

export const store = {
  platform: "",
  settings: defaultSettings as Settings,
  secrets: { githubLogin: "", hasGithubToken: false, hasAnthropicKey: false, hasOpenaiKey: false } as SecretStatus,
  repos: [] as RepoRecord[],
  status: {} as Record<string, RepoStatus | undefined>,
  /** What a repository is doing right now, for its card: "Pulling…". */
  busy: {} as Record<string, string | undefined>,
  /** The last thing that went wrong with a repository, until it next works. */
  errors: {} as Record<string, string | undefined>,
  activeRepoId: null as string | null,
  /** Folder listings, keyed `${repoId}:${folder}`. */
  files: {} as Record<string, FileEntry[] | undefined>,
  /** Upload folder listings, keyed the same way. */
  uploads: {} as Record<string, UploadEntry[] | undefined>,
  /** Uploads in progress, by folder key: "2 of 5". */
  uploading: {} as Record<string, string | undefined>,
  collapsed: new Set<string>(),
  filter: "",
  openFile: null as OpenFile | null,
  // The repositories column starts hidden; the Files column's sidebar button
  // and ⌘\ bring it back.
  layout: { repos: false, files: true, drawer: false, pane: "repos" as Pane },
  preview: { open: false, mode: "live" as "draft" | "live" },
  /** What each repository's last push sent, so the live preview can say a
   *  post is pushed but the site may not have rebuilt yet. `previous` is each
   *  file as GitHub had it before the push (null: new). */
  pushed: {} as Record<string, { at: number; previous: Map<string, string | null> } | undefined>,
  console: { open: false },
  online: typeof navigator === "undefined" ? true : navigator.onLine,
};

const listeners = new Map<Topic, Set<() => void>>();

export function on(topic: Topic | Topic[], fn: () => void): () => void {
  const topics = Array.isArray(topic) ? topic : [topic];
  for (const t of topics) {
    if (!listeners.has(t)) listeners.set(t, new Set());
    listeners.get(t)!.add(fn);
  }
  return () => topics.forEach((t) => listeners.get(t)?.delete(fn));
}

/** Announce changes. Several topics in one call run each listener once. */
export function emit(...topics: Topic[]) {
  const run = new Set<() => void>();
  for (const t of topics) listeners.get(t)?.forEach((fn) => run.add(fn));
  run.forEach((fn) => fn());
}

export const activeRepo = (): RepoRecord | undefined => store.repos.find((r) => r.id === store.activeRepoId);
export const repoById = (id: string): RepoRecord | undefined => store.repos.find((r) => r.id === id);
export const folderKey = (repoId: string, folder: string) => `${repoId}:${folder}`;

/** Every file entry the app has listed for a repository, by path. */
export function knownFile(repoId: string, path: string): FileEntry | undefined {
  for (const [key, list] of Object.entries(store.files)) {
    if (!key.startsWith(`${repoId}:`)) continue;
    const hit = list?.find((f) => f.path === path);
    if (hit) return hit;
  }
  return undefined;
}
