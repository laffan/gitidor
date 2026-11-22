// What URL loads the file behind an image reference, for the editor's inline
// images and the draft preview. Inside the app that is the `gitidor://local`
// scheme; in browser mode (development and screenshots) the mock supplies
// stand-in pictures, since a browser cannot read the clone.

import { inTauri } from "../lib/ipc";
import { localUrl, resolveAsset } from "../lib/site";
import type { RepoRecord } from "../lib/types";

let mockAsset: ((repoId: string, path: string) => string) | null = null;

export function setMockAssetUrl(fn: (repoId: string, path: string) => string) {
  mockAsset = fn;
}

/** `rootRelativeRepoPath` treats `src` as a repository path rather than a site URL. */
export function assetUrl(repo: RepoRecord, filePath: string, src: string, rootRelativeRepoPath = false): string | null {
  const resolved = rootRelativeRepoPath ? { kind: "local" as const, path: src.replace(/^\//, "") } : resolveAsset(repo, filePath, src);
  if (resolved.kind === "remote") return resolved.url;
  if (resolved.kind === "none") return null;
  if (!inTauri && mockAsset) return mockAsset(repo.id, resolved.path);
  return localUrl(repo.id, resolved.path);
}
