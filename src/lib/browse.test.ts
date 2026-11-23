// The site browser's state (actions.ts): what opens and closes it, and what
// it tells the Files column. Runs against the in-memory mock backend.

import { beforeEach, describe, expect, it } from "vitest";
import { folderKey, on, store } from "./store";
import * as actions from "./actions";
import type { RepoRecord } from "./types";

const repo = { id: "blog01", name: "blog", folders: ["posts", "pages"], uploadFolders: [], publicUrl: "https://blog.example.com/" } as unknown as RepoRecord;

beforeEach(() => {
  store.repos = [repo];
  store.activeRepoId = repo.id;
  store.browsing = null;
  store.siteHit = null;
  store.viewing = null;
  store.openFile = null;
  store.collapsed.clear();
});

describe("the site browser", () => {
  it("opens afresh each time, in place of an upload, and says so", () => {
    let heard = 0;
    const off = on("browser", () => heard++);
    store.viewing = { repoId: repo.id, folder: "images", path: "images/a.jpg" };
    actions.browseSite(repo.id);
    const first = store.browsing;
    expect(first).toEqual({ repoId: repo.id });
    expect(store.viewing).toBeNull();
    expect(store.layout.pane).toBe("editor");
    actions.closeBrowser();
    actions.browseSite(repo.id);
    expect(store.browsing).not.toBe(first);
    expect(heard).toBe(3);
    off();
  });

  it("marks the page's file and opens the folders that list it", () => {
    store.collapsed.add(folderKey(repo.id, "posts"));
    store.collapsed.add(folderKey(repo.id, "pages"));
    actions.browseSite(repo.id);
    actions.siteReached({ repoId: repo.id, path: "posts/2010-03-14--crickets.md" });
    expect(store.siteHit).toEqual({ repoId: repo.id, path: "posts/2010-03-14--crickets.md" });
    expect(store.collapsed.has(folderKey(repo.id, "posts"))).toBe(false);
    expect(store.collapsed.has(folderKey(repo.id, "pages"))).toBe(true);
    actions.siteReached(null);
    expect(store.siteHit).toBeNull();
  });

  it("ignores a page reported after it closed", () => {
    actions.browseSite(repo.id);
    actions.closeBrowser();
    actions.siteReached({ repoId: repo.id, path: "posts/a.md" });
    expect(store.siteHit).toBeNull();
  });

  it("gives way to an upload", () => {
    actions.browseSite(repo.id);
    actions.siteReached({ repoId: repo.id, path: "posts/a.md" });
    actions.viewUpload(repo.id, "images", "images/a.jpg");
    expect(store.browsing).toBeNull();
    expect(store.siteHit).toBeNull();
  });

  it("closes when a file opens, from Edit Post or the Files column", async () => {
    actions.browseSite(repo.id);
    actions.siteReached({ repoId: repo.id, path: "posts/2010-03-14--crickets.md" });
    await actions.openFile(repo.id, "posts/2010-03-14--crickets.md");
    expect(store.openFile?.path).toBe("posts/2010-03-14--crickets.md");
    expect(store.browsing).toBeNull();
    expect(store.siteHit).toBeNull();
  });

  it("closes when another repository is chosen", async () => {
    const other = { ...repo, id: "notes02", name: "notes", folders: [] } as unknown as RepoRecord;
    store.repos = [repo, other];
    actions.browseSite(repo.id);
    await actions.selectRepo(other.id);
    expect(store.browsing).toBeNull();
  });
});
