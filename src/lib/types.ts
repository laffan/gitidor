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
  pattern: string;
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
}

export interface RepoRecord {
  id: string;
  name: string;
  owner: string;
  repo: string;
  remoteUrl: string;
  publicUrl: string;
  folders: string[];
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
