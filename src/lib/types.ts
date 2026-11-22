// The shapes the Rust side sends, field for field (serde's camelCase).

export interface Appearance {
  theme: "system" | "light" | "dark";
  font: string;
  customFont: string;
  fontSize: number;
  lineHeight: number;
  columnWidth: number;
  frontmatter: "dim" | "fold" | "show";
  inlineImages: boolean;
  spellcheck: boolean;
  /** Everything in shades of red, for working in the dark. */
  nightVision: boolean;
}

export interface GitSettings {
  authorName: string;
  authorEmail: string;
  commitTemplate: string;
  fetchOnOpen: boolean;
  pushAfterCommit: boolean;
}

export interface AiSettings {
  provider: "none" | "anthropic" | "openai";
  anthropicModel: string;
  openaiModel: string;
}

export interface Settings {
  appearance: Appearance;
  git: GitSettings;
  ai: AiSettings;
  autosaveMs: number;
}

export interface SecretStatus {
  githubLogin: string;
  hasGithubToken: boolean;
  hasAnthropicKey: boolean;
  hasOpenaiKey: boolean;
}

export interface KeyTest {
  models: string[];
  message: string;
}

export interface Route {
  folder: string;
  /** `/blog/{fileSlug}/`, `/photo/{stem|number}/`: see `site.rs`. */
  pattern: string;
  /** A regular expression over the file's path inside the folder, without
   *  its extension; its groups are tokens in `pattern`. Absent: every file. */
  capture?: string;
}

/** One post's URL, tried on the live site. */
export interface SampleCheck {
  path: string;
  url: string;
  status: number;
  outcome: "found" | "reachable" | "different" | "missing" | "error";
}

/** What the live site said about one content folder's URLs. */
export interface RouteCheck {
  folder: string;
  /** The route as it was checked; a check of an edited route is stale. */
  pattern: string;
  capture: string;
  outcome: "ok" | "mixed" | "failed" | "unchecked";
  message: string;
  samples: SampleCheck[];
}

export interface AssetMap {
  urlPrefix: string;
  repoPath: string;
}

export interface SiteProfile {
  generator: string;
  source: "heuristic" | "ai" | "manual" | string;
  routes: Route[];
  assets: AssetMap[];
  stylesheets: string[];
  suggestedFolders: string[];
  publicUrlHint: string;
  notes: string;
  /** The last check of the routes on the live site, one per folder. */
  checks?: RouteCheck[];
  checkedAt?: number;
}

export interface RepoRecord {
  id: string;
  name: string;
  owner: string;
  repo: string;
  remoteUrl: string;
  publicUrl: string;
  folders: string[];
  /** Folders shown with thumbnails, that files can be uploaded into. */
  uploadFolders: string[];
  site: SiteProfile | null;
  addedAt: number;
  lastFetched: number;
  lastPushed: number;
}

export interface RepoCheck {
  cloneUrl: string;
  owner: string;
  repo: string;
  fullName: string;
  description: string;
  private: boolean;
  canPush: boolean;
  defaultBranch: string;
  branches: string[];
  pagesUrl: string;
  pagesConfirmed: boolean;
  signedIn: boolean;
}

export interface RepoSummary {
  fullName: string;
  private: boolean;
  canPush: boolean;
  defaultBranch: string;
  description: string;
}

export type ChangeKind = "modified" | "added" | "deleted" | "renamed" | "conflicted";

export interface Change {
  path: string;
  kind: ChangeKind;
}

export interface CommitInfo {
  id: string;
  short: string;
  summary: string;
  author: string;
  time: number;
}

export interface RepoStatus {
  branch: string;
  head: CommitInfo | null;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  changes: Change[];
  /** Files that commits GitHub does not have yet change. */
  unpushed: string[];
}

export interface RollbackPlan {
  /** `local`: the last commit here. `remote`: GitHub's branch as last fetched. */
  to: "local" | "remote";
  target: CommitInfo;
  /** HEAD when the plan was made; the rollback refuses if it has moved. */
  head: string;
  /** The commit lost changes are shown against. */
  base: string;
  /** Commits that would be lost, newest first. */
  commits: CommitInfo[];
  /** Files whose changes would be lost. */
  files: Change[];
}

export interface Branches {
  current: string;
  local: string[];
  remoteOnly: string[];
}

export type PullOutcome =
  | { kind: "upToDate" }
  | { kind: "noUpstream" }
  | { kind: "fastForward"; commits: number }
  | { kind: "merged"; commits: number };

export interface PullReport {
  outcome: PullOutcome;
  status: RepoStatus;
}

export interface DirInfo {
  path: string;
  depth: number;
  markdown: number;
  markdownTotal: number;
  /** Files of any kind directly inside, and anywhere below. */
  files: number;
  filesTotal: number;
}

/** A file in an upload folder. */
export interface UploadEntry {
  path: string;
  name: string;
  size: number;
  modified: number;
  change: ChangeKind | "";
}

export interface FileEntry {
  path: string;
  name: string;
  title: string;
  date: string;
  draft: boolean;
  url: string | null;
  change: ChangeKind | "";
  modified: number;
}

export interface CloneProgress {
  requestId: string;
  received: number;
  total: number;
  bytes: number;
}
