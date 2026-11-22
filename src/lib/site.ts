// Turning what a post says (`![](/images/blog/a.jpg)`) into a file the app can
// show (`gitidor://local.<id>/public/blog-images/a.jpg`), using the repository's
// site profile. The same rules as `src-tauri/src/site.rs`, from the other side:
// that file maps posts to URLs, this one maps URLs in posts back to files.

import type { RepoRecord, SiteProfile } from "./types";

export type Resolved = { kind: "local"; path: string } | { kind: "remote"; url: string } | { kind: "none" };

/** Split a public URL into origin and base path, as `remote::split_public_url`. */
export function splitPublicUrl(url: string): { origin: string; base: string } | null {
  const m = /^(https?):\/\/([^/?#]+)([^?#]*)/i.exec(url.trim());
  if (!m) return null;
  return { origin: `${m[1].toLowerCase()}://${m[2]}`, base: m[3].replace(/\/+$/, "") };
}

/** `a/b/../c` → `a/c`; null if it climbs out of the repository. */
export function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Where the file behind `src` lives.
 *
 * - `https://` on another site stays remote; on the repository's own public
 *   site it is treated as the root-relative path it really is.
 * - `/x/y.jpg` goes through the asset maps, longest URL prefix first, after
 *   the base path of a project-pages site is taken off.
 * - Anything else is relative to the post, which is how Hugo page bundles and
 *   Astro content collections keep images beside the text.
 */
export function resolveAsset(repo: Pick<RepoRecord, "publicUrl" | "site">, filePath: string, src: string): Resolved {
  let ref = src.trim().replace(/^<|>$/g, "");
  if (!ref) return { kind: "none" };
  if (/^(data|blob):/i.test(ref)) return { kind: "remote", url: ref };

  const site = splitPublicUrl(repo.publicUrl || "");
  if (/^(https?:)?\/\//i.test(ref)) {
    const absolute = ref.startsWith("//") ? `https:${ref}` : ref;
    const target = splitPublicUrl(absolute);
    if (!site || !target || target.origin.replace(/^http:/, "https:") !== site.origin.replace(/^http:/, "https:")) {
      return { kind: "remote", url: absolute };
    }
    ref = target.base || "/";
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return { kind: "remote", url: ref };

  ref = safeDecode(ref.split(/[?#]/)[0]);
  if (ref.startsWith("/")) {
    if (site?.base && (ref === site.base || ref.startsWith(`${site.base}/`))) ref = ref.slice(site.base.length) || "/";
    const path = mapRootRelative(repo.site, ref);
    return path === null ? { kind: "none" } : { kind: "local", path };
  }
  const joined = normalizePath(`${dirname(filePath)}/${ref}`);
  return joined === null ? { kind: "none" } : { kind: "local", path: joined };
}

export function mapRootRelative(profile: SiteProfile | null, urlPath: string): string | null {
  const maps = [...(profile?.assets ?? [])].sort((a, b) => b.urlPrefix.length - a.urlPrefix.length);
  for (const m of maps) {
    const prefix = m.urlPrefix.endsWith("/") ? m.urlPrefix : `${m.urlPrefix}/`;
    if (urlPath.startsWith(prefix) || `${urlPath}/` === prefix) {
      return normalizePath(m.repoPath + urlPath.slice(prefix.length));
    }
  }
  return normalizePath(urlPath);
}

/** The `gitidor://` scheme's address for a host and a path. See `scheme.rs`. */
export function schemeUrl(host: string, path: string): string {
  const encoded = path
    .split("/")
    .filter((p) => p !== "")
    .map(encodeURIComponent)
    .join("/");
  return `gitidor://${host}/${encoded}`;
}

export const localUrl = (repoId: string, path: string) => schemeUrl(`local.${repoId}`, path);

/** The live-preview proxy address for a URL path on the public site. */
export function liveUrl(repoId: string, urlPath: string): string {
  const [path, query] = urlPath.split("?");
  const base = schemeUrl(`live.${repoId}`, path);
  const withSlash = path.endsWith("/") && !base.endsWith("/") ? `${base}/` : base;
  return query ? `${withSlash}?${query}` : withSlash;
}

/** A post's full public address: origin + base path + the route's URL. */
export function publicAddress(repo: Pick<RepoRecord, "publicUrl">, urlPath: string): string | null {
  const site = splitPublicUrl(repo.publicUrl || "");
  if (!site) return null;
  return `${site.origin}${site.base}${urlPath.startsWith("/") ? urlPath : `/${urlPath}`}`;
}

/** The directory new images go in: the folder a `/images/…`-style map points
 *  at, preferring one whose URL prefix mentions images. */
export function imageDirectory(profile: SiteProfile | null, postFolder: string): { dir: string; urlPrefix: string | null } {
  const maps = profile?.assets ?? [];
  const pick =
    maps.find((m) => /img|image|photo|media|upload/i.test(m.urlPrefix) && m.repoPath) ??
    maps.find((m) => /img|image|photo|media|upload/i.test(m.repoPath));
  if (pick) return { dir: pick.repoPath.replace(/\/$/, ""), urlPrefix: pick.urlPrefix };
  return { dir: postFolder, urlPrefix: null };
}

/** How a post should refer to an image saved at `repoPath`. */
export function imageReference(profile: SiteProfile | null, postPath: string, repoPath: string): string {
  const maps = [...(profile?.assets ?? [])].filter((m) => m.repoPath).sort((a, b) => b.repoPath.length - a.repoPath.length);
  for (const m of maps) {
    if (repoPath.startsWith(m.repoPath)) return m.urlPrefix + repoPath.slice(m.repoPath.length);
  }
  // Relative to the post, which resolves the same way in every generator.
  const from = dirname(postPath).split("/").filter(Boolean);
  const to = repoPath.split("/");
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  return [...from.slice(i).map(() => ".."), ...to.slice(i)].join("/");
}
