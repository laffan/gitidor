import { describe, expect, it } from "vitest";
import { checkFor, sampleText, unconfirmed } from "./preview-links";
import type { RouteCheck, SiteProfile } from "./types";

const check = (folder: string, pattern: string, outcome: RouteCheck["outcome"], capture = ""): RouteCheck => ({ folder, pattern, capture, outcome, message: "", samples: [] });

const profile = (routes: SiteProfile["routes"], checks: RouteCheck[]): SiteProfile => ({
  generator: "eleventy",
  source: "ai",
  routes,
  assets: [],
  stylesheets: [],
  suggestedFolders: [],
  publicUrlHint: "",
  notes: "",
  checks,
});

describe("route checks", () => {
  it("speak for a folder only while its route is as it was checked", () => {
    const p = profile([{ folder: "content/photos", pattern: "/photo/{stem|number}/" }], [check("content/photos", "/photo/{stem|number}/", "ok")]);
    expect(checkFor(p, "content/photos")?.outcome).toBe("ok");
    p.routes[0].pattern = "/photo/{stem}/";
    expect(checkFor(p, "content/photos")).toBeUndefined();
    // A capture is part of the route.
    const q = profile([{ folder: "posts", pattern: "/{n}/", capture: "(?<n>\\d+)" }], [check("posts", "/{n}/", "ok")]);
    expect(checkFor(q, "posts")).toBeUndefined();
  });

  it("keep a folder no route covers until a route does", () => {
    const p = profile([], [check("notes", "", "failed")]);
    expect(checkFor(p, "notes")?.outcome).toBe("failed");
    p.routes.push({ folder: "notes", pattern: "/notes/{path}/" });
    expect(checkFor(p, "notes")).toBeUndefined();
  });

  it("leave unconfirmed every folder the site did not say yes to", () => {
    const p = profile(
      [
        { folder: "a", pattern: "/a/{path}/" },
        { folder: "b", pattern: "/b/{path}/" },
        { folder: "c", pattern: "/c/{path}/" },
      ],
      [check("a", "/a/{path}/", "ok"), check("b", "/b/{path}/", "mixed"), check("c", "/c/{path}/", "unchecked")],
    );
    expect(unconfirmed(p, ["a", "b", "c", "d"])).toEqual(["b", "c", "d"]);
    expect(unconfirmed(null, ["a"])).toEqual(["a"]);
  });

  it("say what happened to a sample in a few words", () => {
    expect(sampleText("missing", 404)).toBe("no page there (404)");
    expect(sampleText("found", 200)).toBe("found");
    expect(sampleText("different", 200)).toBe("the page there is not this post");
  });
});
