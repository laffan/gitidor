import { describe, expect, it } from "vitest";
import { imageReference, liveUrl, localUrl, normalizePath, publicAddress, resolveAsset, splitPublicUrl } from "./site";
import { body, findFrontmatter, newPostName, newPostText, parseFrontmatter, slugify } from "./frontmatter";
import type { SiteProfile } from "./types";

// The asset maps detected from the blog this app was written for.
const blog: SiteProfile = {
  generator: "eleventy",
  source: "heuristic",
  routes: [{ folder: "posts", pattern: "/blog/{fileSlug}/" }],
  assets: [
    { urlPrefix: "/public/", repoPath: "public/" },
    { urlPrefix: "/images/blog/", repoPath: "public/blog-images/" },
    { urlPrefix: "/images/essays/", repoPath: "public/essay-thumbnails/" },
    { urlPrefix: "/", repoPath: "" },
  ],
  stylesheets: [],
  suggestedFolders: ["posts"],
  publicUrlHint: "",
  notes: "",
};
const repo = { publicUrl: "https://blog.natelaffan.com/", site: blog };

describe("resolveAsset", () => {
  it("maps a site URL to the folder it is copied from", () => {
    expect(resolveAsset(repo, "posts/2010-03-14--crickets.md", "/images/blog/10.03.13.crickets1.jpg")).toEqual({
      kind: "local",
      path: "public/blog-images/10.03.13.crickets1.jpg",
    });
  });

  it("treats the site's own absolute URLs as root-relative", () => {
    expect(resolveAsset(repo, "posts/a.md", "https://blog.natelaffan.com/images/essays/x.png")).toEqual({
      kind: "local",
      path: "public/essay-thumbnails/x.png",
    });
    expect(resolveAsset(repo, "posts/a.md", "https://example.com/x.png")).toEqual({ kind: "remote", url: "https://example.com/x.png" });
  });

  it("resolves relative paths against the post, and refuses to climb out", () => {
    expect(resolveAsset(repo, "content/posts/trip/index.md", "photo one.jpg")).toEqual({ kind: "local", path: "content/posts/trip/photo one.jpg" });
    expect(resolveAsset(repo, "content/posts/trip/index.md", "../shared/a%20b.png")).toEqual({ kind: "local", path: "content/posts/shared/a b.png" });
    expect(resolveAsset(repo, "a.md", "../../etc/passwd")).toEqual({ kind: "none" });
  });

  it("strips a project site's base path", () => {
    const project = { publicUrl: "https://laffan.github.io/notes/", site: { ...blog, assets: [{ urlPrefix: "/", repoPath: "static/" }] } };
    expect(resolveAsset(project, "content/a.md", "/notes/img/a.png")).toEqual({ kind: "local", path: "static/img/a.png" });
  });
});

describe("URLs", () => {
  it("splits public URLs", () => {
    expect(splitPublicUrl("https://laffan.github.io/notes/")).toEqual({ origin: "https://laffan.github.io", base: "/notes" });
    expect(splitPublicUrl("nope")).toBeNull();
  });

  it("builds scheme addresses with the repository in the host", () => {
    expect(localUrl("abc123", "public/blog images/a.jpg")).toBe("gitidor://local.abc123/public/blog%20images/a.jpg");
    expect(liveUrl("abc123", "/blog/-crickets/")).toBe("gitidor://live.abc123/blog/-crickets/");
    expect(liveUrl("abc123", "/")).toBe("gitidor://live.abc123/");
    expect(publicAddress(repo, "/blog/-crickets/")).toBe("https://blog.natelaffan.com/blog/-crickets/");
  });

  it("normalises paths", () => {
    expect(normalizePath("a/./b/../c")).toBe("a/c");
    expect(normalizePath("../a")).toBeNull();
  });

  it("refers to a saved image the way the site serves it", () => {
    expect(imageReference(blog, "posts/a.md", "public/blog-images/new.jpg")).toBe("/images/blog/new.jpg");
    expect(imageReference(null, "content/posts/trip/index.md", "content/posts/trip/a.jpg")).toBe("a.jpg");
    expect(imageReference(null, "content/posts/a.md", "static/img/a.jpg")).toBe("../../static/img/a.jpg");
  });
});

describe("frontmatter", () => {
  const yaml = "---\ntitle: Crickets\ndate: 2010-03-14\nsummary: The Low Anthem\ntags: [music]\nimagePost: true\n---\nBody text\n";
  const toml = "+++\ntitle = 'Leap'\ndate = 2024-02-29\ndraft = true\n+++\n\nHello";

  it("finds and parses both formats", () => {
    const y = parseFrontmatter(yaml)!;
    expect(y.format).toBe("yaml");
    expect(y.data.title).toBe("Crickets");
    expect(body(yaml)).toBe("Body text\n");
    const t = parseFrontmatter(toml)!;
    expect(t.format).toBe("toml");
    expect(t.data.title).toBe("Leap");
    expect(t.data.draft).toBe(true);
    expect(body(toml)).toBe("\nHello");
  });

  it("ignores text that only looks like it", () => {
    expect(findFrontmatter("--- not a fence\n")).toBeNull();
    expect(findFrontmatter("---\ntitle: never closed\n")).toBeNull();
    expect(parseFrontmatter("# Heading")).toBeNull();
  });

  it("reports invalid YAML instead of throwing", () => {
    const bad = parseFrontmatter("---\ntitle: [unclosed\n---\n")!;
    expect(bad.error).toBeTruthy();
  });

  it("makes a new post shaped like the newest one", () => {
    const text = newPostText(yaml, "Thrum", "2026-11-22");
    expect(text).toBe('---\ntitle: Thrum\ndate: 2026-11-22\nsummary: ""\ntags: []\n---\n\n');
    const t = newPostText(toml, "Next", "2026-11-22");
    expect(t.startsWith("+++\n")).toBe(true);
    expect(parseFrontmatter(t)!.data.title).toBe("Next");
    expect(parseFrontmatter(newPostText(null, "Hi", "2026-01-01"))!.data).toEqual({ title: "Hi", date: "2026-01-01" });
  });

  it("names a new post in the folder's convention", () => {
    expect(newPostName(["2010-03-14--crickets.md", "2011-01-25--linen.md"], "Ode to Obsession", "2026-11-22")).toBe("2026-11-22--ode-to-obsession.md");
    expect(newPostName(["2024-02-29-leap.markdown", "2024-03-01-x.markdown"], "New", "2026-11-22")).toBe("2026-11-22-new.markdown");
    expect(newPostName(["about.md", "now.md"], "Café Notes", "2026-11-22")).toBe("cafe-notes.md");
    expect(slugify("  Hello, World!  ")).toBe("hello-world");
  });
});
