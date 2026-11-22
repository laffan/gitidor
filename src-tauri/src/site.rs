//! What the site is made of: which folders hold posts, what URL each post is
//! published at, and where the files behind a site URL like `/images/x.jpg`
//! actually live in the repository.
//!
//! That last question is the one the editor cannot answer without help. In the
//! blog this app was first written for, a post says `![](/images/blog/a.jpg)`
//! and the file is `public/blog-images/a.jpg`, because `.eleventy.js` copies
//! one to the other at build time. A preview that resolved image paths against
//! the repository root would show nothing.
//!
//! So a repository gets a **site profile**: routes (folder → URL pattern) and
//! asset maps (URL prefix → repository path). [`detect`] makes one from the
//! generator's own config — Eleventy, Jekyll, Hugo and Astro are read
//! directly — and `ai.rs` can refine it by showing a model the same config.
//! Either way the result is plain data the person can read and correct in the
//! repository's site sheet, and everything downstream (inline images, the
//! draft preview, "edit this page" in the live preview) uses only that data.
//!
//! ## URL patterns
//!
//! Patterns are written with braces, independent of any generator:
//!
//! | token        | `posts/2010-03-14--crickets.md`, `date: 2010-03-14`, `title: Crickets` |
//! |--------------|-------------------------------------------------------------------------|
//! | `{path}`     | `2010-03-14--crickets` — path inside the folder, no extension, `/index` dropped |
//! | `{stem}`     | `2010-03-14--crickets` — the last segment of `{path}` |
//! | `{fileSlug}` | `-crickets` — `{stem}` with a leading `YYYY-MM-DD-` removed (Eleventy's `page.fileSlug`, Jekyll's `:title`) |
//! | `{slug}`     | frontmatter `slug`, else `{fileSlug}` |
//! | `{title}`    | frontmatter `title`, slugified, else `{fileSlug}` |
//! | `{year}` `{month}` `{day}` | from frontmatter `date`, else from the filename |
//! | `{dir}`      | the folders between the route folder and the file |
//!
//! A frontmatter `permalink` or `url` that is a plain path wins over the
//! pattern; `permalink: false` means the file is not published.

use crate::frontmatter::{self, Front};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Route {
    pub folder: String,
    pub pattern: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AssetMap {
    /// Begins and ends with `/`: `/images/blog/`.
    pub url_prefix: String,
    /// Repository-relative, ends with `/` unless it is the root (empty).
    pub repo_path: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SiteProfile {
    /// `eleventy`, `jekyll`, `hugo`, `astro`, or `unknown`.
    pub generator: String,
    /// `heuristic`, `ai` or `manual`.
    pub source: String,
    pub routes: Vec<Route>,
    pub assets: Vec<AssetMap>,
    /// Repository paths of CSS files the draft preview can borrow.
    pub stylesheets: Vec<String>,
    /// Folders that look like they hold posts, most likely first.
    pub suggested_folders: Vec<String>,
    /// A custom domain found in a `CNAME` file, as `https://…/`.
    pub public_url_hint: String,
    pub notes: String,
}

// ── URLs ────────────────────────────────────────────────────────────────────

/// The URL path (below the site's base path) a file is published at.
pub fn url_for(profile: &SiteProfile, rel_path: &str, front: &Front) -> Option<String> {
    if front.is_draft() {
        return None;
    }
    if let Some(explicit) = front.get("permalink").or_else(|| front.get("url")) {
        if explicit == "false" {
            return None;
        }
        if !explicit.contains("{{") && !explicit.contains("{%") && !explicit.contains(':') {
            return Some(clean_url(explicit));
        }
    }
    let route = route_for(profile, rel_path)?;
    Some(expand(&route.pattern, &tokens(&route.folder, rel_path, front)))
}

fn route_for<'a>(profile: &'a SiteProfile, rel_path: &str) -> Option<&'a Route> {
    profile
        .routes
        .iter()
        .filter(|r| r.folder.is_empty() || rel_path.starts_with(&format!("{}/", r.folder.trim_matches('/'))))
        .max_by_key(|r| r.folder.len())
}

pub fn tokens(folder: &str, rel_path: &str, front: &Front) -> BTreeMap<&'static str, String> {
    let folder = folder.trim_matches('/');
    let within = if folder.is_empty() { rel_path } else { rel_path.strip_prefix(folder).unwrap_or(rel_path).trim_start_matches('/') };
    let no_ext = match within.rfind('.') {
        Some(dot) if !within[dot..].contains('/') => &within[..dot],
        _ => within,
    };
    let path = ["/index", "/_index"]
        .iter()
        .find_map(|tail| no_ext.strip_suffix(tail))
        .unwrap_or(if no_ext == "index" || no_ext == "_index" { "" } else { no_ext })
        .to_string();
    let stem = path.rsplit('/').next().filter(|s| !s.is_empty()).unwrap_or_else(|| folder.rsplit('/').next().unwrap_or("")).to_string();
    let dir = path.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default();
    let file_slug = strip_date(&stem).to_string();
    let (year, month, day) = front.date().or_else(|| frontmatter::ymd_prefix(&stem)).unwrap_or_default();

    let mut t = BTreeMap::new();
    t.insert("slug", front.get("slug").map(str::to_string).unwrap_or_else(|| file_slug.clone()));
    t.insert("title", front.get("title").map(slugify).filter(|s| !s.is_empty()).unwrap_or_else(|| file_slug.clone()));
    t.insert("fileSlug", file_slug);
    t.insert("path", path);
    t.insert("stem", stem);
    t.insert("dir", dir);
    t.insert("year", year);
    t.insert("month", month);
    t.insert("day", day);
    t
}

/// Eleventy's `page.fileSlug` rule (and Jekyll's `:title`): a leading
/// `YYYY-MM-DD-` comes off, exactly one hyphen with it — which is why
/// `2010-03-14--crickets` publishes as `-crickets`.
pub fn strip_date(stem: &str) -> &str {
    if frontmatter::ymd_prefix(stem).is_some() && stem.as_bytes().get(10) == Some(&b'-') {
        &stem[11..]
    } else {
        stem
    }
}

pub fn expand(pattern: &str, tokens: &BTreeMap<&'static str, String>) -> String {
    let mut out = pattern.to_string();
    for (key, value) in tokens {
        out = out.replace(&format!("{{{key}}}"), value);
    }
    clean_url(&out)
}

/// One leading slash, no doubled slashes, the trailing slash as written.
fn clean_url(url: &str) -> String {
    let mut out = String::with_capacity(url.len() + 1);
    out.push('/');
    for c in url.trim().chars() {
        if c == '/' && out.ends_with('/') {
            continue;
        }
        out.push(c);
    }
    out
}

pub fn slugify(text: &str) -> String {
    let mut out = String::new();
    for c in text.trim().chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            out.push(c);
        } else if (c.is_whitespace() || c == '-' || c == '_') && !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    out.trim_end_matches('-').to_string()
}

/// A URL path reduced to the form both sides of a lookup are compared in:
/// decoded, no query, no `index.html`, no trailing slash.
pub fn normalize_url_path(url_path: &str) -> String {
    let path = url_path.split(['?', '#']).next().unwrap_or_default();
    let decoded = percent_encoding::percent_decode_str(path).decode_utf8_lossy().to_string();
    let trimmed = decoded.strip_suffix("index.html").unwrap_or(&decoded);
    let trimmed = trimmed.trim_end_matches('/');
    if trimmed.is_empty() {
        "/".into()
    } else if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    }
}

// ── detection ───────────────────────────────────────────────────────────────

const SKIP_DIRS: &[&str] = &["node_modules", "_site", "dist", "build", "out", "vendor", "_includes", "_layouts", "_data", "layouts", "themes", "resources"];

/// Directories with markdown directly inside them, and how many.
pub fn markdown_dirs(root: &Path, max_depth: usize) -> Vec<(String, usize)> {
    let mut out = Vec::new();
    walk_dirs(root, root, 0, max_depth, &mut out);
    out.sort();
    out
}

fn walk_dirs(root: &Path, dir: &Path, depth: usize, max_depth: usize, out: &mut Vec<(String, usize)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut md = 0;
    let mut readme_only = true;
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_str()) && depth < max_depth {
                subdirs.push(path);
            }
        } else if is_markdown(&name) {
            md += 1;
            if !name.eq_ignore_ascii_case("readme.md") {
                readme_only = false;
            }
        }
    }
    if md > 0 && !(readme_only && md == 1) {
        out.push((crate::store::rel_string(root, dir), md));
    }
    for sub in subdirs {
        walk_dirs(root, &sub, depth + 1, max_depth, out);
    }
}

pub fn is_markdown(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".mdx")
}

fn read(root: &Path, rel: &str) -> Option<String> {
    std::fs::read_to_string(root.join(rel)).ok()
}

fn first_existing(root: &Path, names: &[&str]) -> Option<(String, String)> {
    names.iter().find_map(|n| read(root, n).map(|t| (n.to_string(), t)))
}

pub fn detect(root: &Path) -> SiteProfile {
    let dirs = markdown_dirs(root, 4);
    let package = read(root, "package.json").unwrap_or_default();

    let mut profile = if let Some((name, config)) = first_existing(
        root,
        &[".eleventy.js", "eleventy.config.js", "eleventy.config.mjs", "eleventy.config.cjs", ".eleventy.cjs"],
    )
    .or_else(|| package.contains("@11ty/eleventy").then(|| ("package.json".into(), String::new())))
    {
        eleventy(root, &name, &config, &dirs)
    } else if let Some((_, config)) = first_existing(root, &["hugo.toml", "hugo.yaml", "hugo.yml", "hugo.json"])
        .or_else(|| first_existing(root, &["config.toml", "config.yaml"]).filter(|(_, t)| t.to_ascii_lowercase().contains("baseurl")))
    {
        hugo(root, &config, &dirs)
    } else if let Some((_, config)) = first_existing(root, &["_config.yml", "_config.yaml"]) {
        jekyll(&config, &dirs)
    } else if first_existing(root, &["astro.config.mjs", "astro.config.ts", "astro.config.js"]).is_some() {
        astro(root, &dirs)
    } else {
        generic(root, &dirs)
    };

    profile.source = "heuristic".into();
    profile.stylesheets = stylesheets(root);
    profile.public_url_hint = cname(root);
    if profile.suggested_folders.is_empty() {
        profile.suggested_folders = suggest(&dirs, &[]);
    }
    profile
}

/// Content folders, the conventional names first, then by how many posts.
fn suggest(dirs: &[(String, usize)], exclude_prefixes: &[&str]) -> Vec<String> {
    let rank = |name: &str| -> usize {
        let last = name.rsplit('/').next().unwrap_or(name);
        match last {
            "posts" | "_posts" | "blog" | "articles" | "entries" | "notes" | "essays" => 0,
            _ if name.starts_with("content") || name.starts_with("src/content") => 1,
            _ => 2,
        }
    };
    let mut list: Vec<&(String, usize)> = dirs
        .iter()
        .filter(|(d, _)| !d.is_empty() && !exclude_prefixes.iter().any(|p| d.starts_with(p)))
        .collect();
    list.sort_by(|a, b| rank(&a.0).cmp(&rank(&b.0)).then(b.1.cmp(&a.1)).then(a.0.cmp(&b.0)));
    list.into_iter().map(|(d, _)| d.clone()).take(8).collect()
}

fn eleventy(root: &Path, _config_name: &str, config: &str, dirs: &[(String, usize)]) -> SiteProfile {
    let input = capture(config, r#"input"#).unwrap_or_else(|| ".".into());
    let input = input.trim_start_matches("./").trim_matches('/').to_string();
    let input = if input == "." { String::new() } else { input };

    let mut assets = Vec::new();
    for (from, to) in passthrough_copies(config) {
        let from = from.trim_start_matches("./").trim_matches('/').to_string();
        let to = to.trim_start_matches("./").trim_matches('/').to_string();
        if root.join(&from).is_dir() {
            assets.push(AssetMap { url_prefix: format!("/{to}/"), repo_path: format!("{from}/") });
        }
    }
    // A passthrough copy keeps paths relative to the input directory.
    assets.push(AssetMap { url_prefix: "/".into(), repo_path: if input.is_empty() { String::new() } else { format!("{input}/") } });

    let folders = suggest(dirs, &["_site"]);
    let mut notes = Vec::new();
    let routes = folders
        .iter()
        .map(|folder| {
            let relative = folder.strip_prefix(&input).unwrap_or(folder).trim_matches('/').to_string();
            let default = format!("/{relative}/{{path}}/");
            let pattern = eleventy_directory_permalink(root, folder)
                .map(|template| match translate_eleventy(&template, &relative) {
                    Some(p) => p,
                    None => {
                        notes.push(format!("{folder}: permalink template `{template}` is not understood; using the default."));
                        default.clone()
                    }
                })
                .unwrap_or(default);
            Route { folder: folder.clone(), pattern }
        })
        .collect();

    SiteProfile {
        generator: "eleventy".into(),
        routes,
        assets,
        suggested_folders: folders,
        notes: notes.join("\n"),
        ..Default::default()
    }
}

/// The `permalink` from a folder's directory data file, Eleventy's way of
/// giving every file in a folder the same URL shape.
fn eleventy_directory_permalink(root: &Path, folder: &str) -> Option<String> {
    let base = folder.rsplit('/').next().unwrap_or(folder);
    for name in [format!("{base}.json"), format!("{base}.11tydata.json"), format!("{base}.11tydata.js"), format!("{base}.11tydata.cjs")] {
        if let Some(text) = read(root, &format!("{folder}/{name}")) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(p) = value.get("permalink").and_then(|p| p.as_str()) {
                    return Some(p.to_string());
                }
            }
            if let Some(p) = capture(&text, "permalink") {
                return Some(p);
            }
        }
    }
    None
}

/// An Eleventy permalink template in this module's pattern language, for the
/// expressions that are common enough to be worth knowing.
pub fn translate_eleventy(template: &str, folder: &str) -> Option<String> {
    let mut out = String::new();
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let end = rest[start..].find("}}")? + start;
        let expr: String = rest[start + 2..end].split_whitespace().collect::<Vec<_>>().join(" ");
        let token = match expr.as_str() {
            "page.fileSlug" => "{fileSlug}".to_string(),
            "page.filePathStem" => format!("/{folder}/{{path}}"),
            "title | slugify" | "title | slug" | "title|slugify" | "title|slug" => "{title}".to_string(),
            "slug" | "page.slug" => "{slug}".to_string(),
            _ => return None,
        };
        out.push_str(&token);
        rest = &rest[end + 2..];
    }
    out.push_str(rest);
    (!out.contains("{%")).then(|| clean_url(&out))
}

/// Pairs from `addPassthroughCopy({ "from": "to" })` and the bare
/// `addPassthroughCopy("dir")`, which copies a directory to the same path.
pub fn passthrough_copies(config: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = config;
    while let Some(i) = rest.find("addPassthroughCopy(") {
        rest = &rest[i + "addPassthroughCopy(".len()..];
        let body = rest.trim_start();
        if let Some(obj) = body.strip_prefix('{') {
            let Some(end) = obj.find('}') else { break };
            let strings = quoted_strings(&obj[..end]);
            for pair in strings.chunks(2) {
                if let [from, to] = pair {
                    out.push((from.clone(), to.clone()));
                }
            }
        } else if let Some(s) = quoted_strings(body.split(')').next().unwrap_or_default()).first() {
            if !s.contains('*') {
                out.push((s.clone(), s.clone()));
            }
        }
    }
    out
}

fn quoted_strings(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = text.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if c == '"' || c == '\'' || c == '`' {
            if let Some(len) = text[i + 1..].find(c) {
                out.push(text[i + 1..i + 1 + len].to_string());
                while let Some((j, _)) = chars.peek() {
                    if *j <= i + 1 + len {
                        chars.next();
                    } else {
                        break;
                    }
                }
            }
        }
    }
    out
}

/// The first `key: "value"` / `key = "value"` / `key: value` for `key`.
fn capture(text: &str, key: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim().trim_end_matches(',');
        let Some(rest) = line.strip_prefix(key) else { continue };
        let rest = rest.trim_start();
        let Some(value) = rest.strip_prefix(':').or_else(|| rest.strip_prefix('=')) else { continue };
        let value = value.trim();
        if let Some(q) = quoted_strings(value).into_iter().next() {
            return Some(q);
        }
        if !value.is_empty() && !value.starts_with('{') && !value.starts_with('[') {
            return Some(value.split(" #").next().unwrap_or(value).trim().to_string());
        }
    }
    None
}

fn jekyll(config: &str, dirs: &[(String, usize)]) -> SiteProfile {
    let style = capture(config, "permalink").unwrap_or_else(|| "date".into());
    let pretty = style == "pretty" || style.ends_with('/');
    let post_pattern = match style.as_str() {
        "date" => "/{year}/{month}/{day}/{fileSlug}.html".to_string(),
        "pretty" => "/{year}/{month}/{day}/{fileSlug}/".to_string(),
        "none" => "/{fileSlug}.html".to_string(),
        "ordinal" | "weekdate" => "/{year}/{fileSlug}.html".to_string(),
        custom => translate_colon_tokens(custom),
    };
    let folders = suggest(dirs, &["_drafts"]);
    let routes = folders
        .iter()
        .map(|folder| {
            let pattern = if folder.rsplit('/').next() == Some("_posts") {
                post_pattern.clone()
            } else if pretty {
                format!("/{folder}/{{path}}/")
            } else {
                format!("/{folder}/{{path}}.html")
            };
            Route { folder: folder.clone(), pattern }
        })
        .collect();
    SiteProfile {
        generator: "jekyll".into(),
        routes,
        // Jekyll copies every file not starting with `_` to the same path.
        assets: vec![AssetMap { url_prefix: "/".into(), repo_path: String::new() }],
        suggested_folders: folders,
        notes: "Jekyll's :categories are left out of post URLs.".into(),
        ..Default::default()
    }
}

/// `:year/:month/:title` style tokens, shared by Jekyll and Hugo.
pub fn translate_colon_tokens(pattern: &str) -> String {
    let mut out = pattern.to_string();
    for (from, to) in [
        (":categories", ""),
        (":section", "{dir}"),
        (":output_ext", ".html"),
        (":contentbasename", "{stem}"),
        (":filename", "{stem}"),
        (":i_month", "{month}"),
        (":i_day", "{day}"),
        (":year", "{year}"),
        (":month", "{month}"),
        (":day", "{day}"),
        (":title", "{fileSlug}"),
        (":slugorfilename", "{slug}"),
        (":slug", "{slug}"),
        (":name", "{stem}"),
    ] {
        out = out.replace(from, to);
    }
    clean_url(&out)
}

fn hugo(root: &Path, config: &str, dirs: &[(String, usize)]) -> SiteProfile {
    let content = capture(config, "contentDir").unwrap_or_else(|| "content".into());
    let mut permalinks = BTreeMap::new();
    let mut in_section = false;
    for line in config.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            in_section = t == "[permalinks]";
            continue;
        }
        if t == "permalinks:" {
            in_section = true;
            continue;
        }
        if in_section {
            if let Some((k, v)) = t.split_once('=').or_else(|| t.split_once(':')) {
                if let Some(v) = quoted_strings(v).into_iter().next() {
                    permalinks.insert(k.trim().trim_matches('"').to_string(), v);
                }
            } else if !line.starts_with([' ', '\t']) && !t.is_empty() {
                in_section = false;
            }
        }
    }
    let folders = suggest(dirs, &[]);
    let routes = folders
        .iter()
        .map(|folder| {
            let section_path = folder.strip_prefix(&content).unwrap_or(folder).trim_matches('/').to_string();
            let section = section_path.split('/').next().unwrap_or("").to_string();
            let pattern = permalinks
                .get(&section)
                .map(|p| translate_colon_tokens(&p.replace(":section", &section)))
                .unwrap_or_else(|| format!("/{section_path}/{{path}}/"));
            Route { folder: folder.clone(), pattern }
        })
        .collect();
    let static_dir = if root.join("static").is_dir() { "static/" } else { "" };
    SiteProfile {
        generator: "hugo".into(),
        routes,
        assets: vec![AssetMap { url_prefix: "/".into(), repo_path: static_dir.into() }],
        suggested_folders: folders,
        notes: "Hugo page bundles (a folder with index.md) resolve images relative to the post.".into(),
        ..Default::default()
    }
}

fn astro(root: &Path, dirs: &[(String, usize)]) -> SiteProfile {
    let folders = suggest(dirs, &[]);
    let routes = folders
        .iter()
        .map(|folder| {
            let pattern = if let Some(page) = folder.strip_prefix("src/pages") {
                format!("/{}/{{path}}/", page.trim_matches('/'))
            } else if let Some(coll) = folder.strip_prefix("src/content/") {
                format!("/{coll}/{{path}}/")
            } else {
                format!("/{folder}/{{path}}/")
            };
            Route { folder: folder.clone(), pattern }
        })
        .collect();
    SiteProfile {
        generator: "astro".into(),
        routes,
        assets: vec![AssetMap { url_prefix: "/".into(), repo_path: if root.join("public").is_dir() { "public/".into() } else { String::new() } }],
        suggested_folders: folders,
        notes: "Astro content collections are routed by code; the patterns here are a guess worth checking.".into(),
        ..Default::default()
    }
}

fn generic(root: &Path, dirs: &[(String, usize)]) -> SiteProfile {
    let folders = suggest(dirs, &[]);
    let routes = folders.iter().map(|f| Route { folder: f.clone(), pattern: format!("/{f}/{{path}}/") }).collect();
    let assets_root = ["public", "static"].iter().find(|d| root.join(d).is_dir()).map(|d| format!("{d}/")).unwrap_or_default();
    SiteProfile {
        generator: "unknown".into(),
        routes,
        assets: vec![AssetMap { url_prefix: "/".into(), repo_path: assets_root }],
        suggested_folders: folders,
        notes: "No site generator was recognised; URLs and image paths are guesses.".into(),
        ..Default::default()
    }
}

fn stylesheets(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for dir in ["styles", "css", "assets/css", "static/css", "public/css", "src/styles", "public/styles"] {
        let Ok(entries) = std::fs::read_dir(root.join(dir)) else { continue };
        let mut found: Vec<String> = entries
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".css"))
            .map(|n| format!("{dir}/{n}"))
            .collect();
        found.sort();
        out.extend(found);
    }
    out.truncate(10);
    out
}

fn cname(root: &Path) -> String {
    for rel in ["CNAME", "public/CNAME", "static/CNAME", "docs/CNAME", "src/CNAME"] {
        if let Some(text) = read(root, rel) {
            let domain = text.lines().next().unwrap_or_default().trim();
            if !domain.is_empty() && domain.contains('.') && !domain.contains(' ') {
                return format!("https://{domain}/");
            }
        }
    }
    String::new()
}

/// Keep only what can be trusted from a profile that came from outside this
/// module — a model's answer, or a hand edit: folders that exist, repository
/// paths that stay inside the repository, URL prefixes that are paths.
pub fn sanitize(root: &Path, mut profile: SiteProfile) -> SiteProfile {
    let safe_dir = |p: &str| crate::store::safe_relative(p).ok().filter(|rel| root.join(rel).is_dir()).is_some();
    profile.routes.retain(|r| {
        !r.pattern.trim().is_empty() && (r.folder.is_empty() || safe_dir(&r.folder))
    });
    for r in &mut profile.routes {
        r.folder = r.folder.trim_matches('/').to_string();
        if !r.pattern.starts_with('/') {
            r.pattern = format!("/{}", r.pattern);
        }
    }
    profile.assets.retain(|a| a.url_prefix.starts_with('/') && (a.repo_path.is_empty() || safe_dir(&a.repo_path)));
    for a in &mut profile.assets {
        if !a.url_prefix.ends_with('/') {
            a.url_prefix.push('/');
        }
        let trimmed = a.repo_path.trim_matches('/');
        a.repo_path = if trimmed.is_empty() { String::new() } else { format!("{trimmed}/") };
    }
    profile.stylesheets.retain(|s| crate::store::safe_relative(s).ok().filter(|rel| root.join(rel).is_file()).is_some());
    profile.suggested_folders.retain(|f| safe_dir(f));
    profile
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn front(text: &str) -> Front {
        frontmatter::parse(text)
    }

    /// The shape of the blog this app was written for, in miniature.
    fn eleventy_blog() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("gitidor-site-{}-{}", std::process::id(), crate::store::new_id()));
        fs::create_dir_all(root.join("posts")).unwrap();
        fs::create_dir_all(root.join("public/blog-images")).unwrap();
        fs::create_dir_all(root.join("public/essay-thumbnails")).unwrap();
        fs::create_dir_all(root.join("styles")).unwrap();
        fs::create_dir_all(root.join("_includes")).unwrap();
        fs::write(
            root.join(".eleventy.js"),
            r#"module.exports = function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy("public");
  eleventyConfig.addPassthroughCopy({ "public/CNAME": "CNAME" });
  eleventyConfig.addPassthroughCopy({ "public/blog-images": "images/blog" });
  eleventyConfig.addPassthroughCopy({
    "public/essay-thumbnails": "images/essays",
  });
  eleventyConfig.addPassthroughCopy("styles");
  return { dir: { input: ".", includes: "_includes", output: "_site" } };
};"#,
        )
        .unwrap();
        fs::write(root.join("posts/posts.json"), r#"{ "layout": "post.njk", "permalink": "/blog/{{ page.fileSlug }}/" }"#).unwrap();
        fs::write(root.join("posts/2010-03-14--crickets.md"), "---\ntitle: Crickets\ndate: 2010-03-14\n---\n![](/images/blog/a.jpg)\n").unwrap();
        fs::write(root.join("posts/2011-01-25--linen-lampshades.md"), "---\ntitle: Linen\n---\n").unwrap();
        fs::write(root.join("public/about.md"), "about").unwrap();
        fs::write(root.join("public/CNAME"), "blog.natelaffan.com\n").unwrap();
        fs::write(root.join("README.md"), "readme").unwrap();
        fs::write(root.join("styles/main.css"), "body{}").unwrap();
        fs::write(root.join("_includes/note.md"), "x").unwrap();
        root
    }

    #[test]
    fn the_eleventy_blog_is_understood_from_its_config() {
        let root = eleventy_blog();
        let p = detect(&root);
        assert_eq!(p.generator, "eleventy");
        assert_eq!(p.suggested_folders[0], "posts");
        assert!(!p.suggested_folders.iter().any(|f| f == "_includes"));
        let route = p.routes.iter().find(|r| r.folder == "posts").unwrap();
        assert_eq!(route.pattern, "/blog/{fileSlug}/");
        assert!(p.assets.contains(&AssetMap { url_prefix: "/images/blog/".into(), repo_path: "public/blog-images/".into() }));
        assert!(p.assets.contains(&AssetMap { url_prefix: "/images/essays/".into(), repo_path: "public/essay-thumbnails/".into() }));
        assert!(p.assets.contains(&AssetMap { url_prefix: "/public/".into(), repo_path: "public/".into() }));
        assert_eq!(p.public_url_hint, "https://blog.natelaffan.com/");
        assert_eq!(p.stylesheets, vec!["styles/main.css".to_string()]);

        // The URL the live site actually serves for this post.
        let f = front("---\ntitle: Crickets\ndate: 2010-03-14\n---\n");
        assert_eq!(url_for(&p, "posts/2010-03-14--crickets.md", &f).as_deref(), Some("/blog/-crickets/"));
    }

    #[test]
    fn tokens_follow_each_generators_conventions() {
        let f = front("---\ntitle: Hello, World!\ndate: 2024-02-29\n---\n");
        let t = tokens("_posts", "_posts/2024-02-29-hello.md", &f);
        assert_eq!(t["fileSlug"], "hello");
        assert_eq!(t["title"], "hello-world");
        assert_eq!((t["year"].as_str(), t["month"].as_str(), t["day"].as_str()), ("2024", "02", "29"));

        let bundle = tokens("content/posts", "content/posts/my-trip/index.md", &front(""));
        assert_eq!(bundle["path"], "my-trip");
        assert_eq!(bundle["stem"], "my-trip");

        let nested = tokens("posts", "posts/2020/spring.md", &front(""));
        assert_eq!(nested["dir"], "2020");
        assert_eq!(nested["path"], "2020/spring");
    }

    #[test]
    fn frontmatter_permalinks_and_drafts_win() {
        let p = SiteProfile { routes: vec![Route { folder: "posts".into(), pattern: "/blog/{slug}/".into() }], ..Default::default() };
        assert_eq!(url_for(&p, "posts/a.md", &front("---\nslug: custom\n---\n")).as_deref(), Some("/blog/custom/"));
        assert_eq!(url_for(&p, "posts/a.md", &front("---\npermalink: /elsewhere/\n---\n")).as_deref(), Some("/elsewhere/"));
        assert_eq!(url_for(&p, "posts/a.md", &front("---\npermalink: false\n---\n")), None);
        assert_eq!(url_for(&p, "posts/a.md", &front("---\ndraft: true\n---\n")), None);
        assert_eq!(url_for(&p, "pages/a.md", &front("")), None);
    }

    #[test]
    fn jekyll_and_hugo_permalink_styles() {
        assert_eq!(translate_colon_tokens("/:categories/:year/:month/:day/:title:output_ext"), "/{year}/{month}/{day}/{fileSlug}.html");
        assert_eq!(translate_colon_tokens("/:year/:slug/"), "/{year}/{slug}/");
        let dirs = vec![("_posts".to_string(), 3), ("about".to_string(), 1)];
        let j = jekyll("title: x\npermalink: pretty\n", &dirs);
        assert_eq!(j.routes[0], Route { folder: "_posts".into(), pattern: "/{year}/{month}/{day}/{fileSlug}/".into() });
    }

    #[test]
    fn eleventy_templates_that_are_not_understood_are_refused() {
        assert_eq!(translate_eleventy("/blog/{{ page.fileSlug }}/", "posts").as_deref(), Some("/blog/{fileSlug}/"));
        assert_eq!(translate_eleventy("/{{ title | slugify }}/", "posts").as_deref(), Some("/{title}/"));
        assert_eq!(translate_eleventy("/{{ page.date | date: 'yyyy' }}/", "posts"), None);
    }

    #[test]
    fn url_paths_compare_in_one_form() {
        assert_eq!(normalize_url_path("/blog/-crickets/"), "/blog/-crickets");
        assert_eq!(normalize_url_path("/blog/-crickets/index.html?x=1"), "/blog/-crickets");
        assert_eq!(normalize_url_path("/caf%C3%A9/"), "/café");
        assert_eq!(normalize_url_path("/"), "/");
    }

    /// Point `GITIDOR_SITE` at a real checkout to see what is detected.
    #[test]
    #[ignore]
    fn detect_a_real_checkout() {
        let root = std::path::PathBuf::from(std::env::var("GITIDOR_SITE").expect("set GITIDOR_SITE"));
        let p = detect(&root);
        println!("{}", serde_json::to_string_pretty(&p).unwrap());
        for f in ["posts/2010-03-14--crickets.md", "posts/2009-12-31--my-tribe.md"] {
            if let Ok(text) = std::fs::read_to_string(root.join(f)) {
                println!("{f} -> {:?}", url_for(&p, f, &frontmatter::parse(&text)));
            }
        }
    }

    #[test]
    fn sanitize_drops_what_is_not_there() {
        let root = eleventy_blog();
        let p = sanitize(
            &root,
            SiteProfile {
                routes: vec![Route { folder: "posts".into(), pattern: "blog/{slug}/".into() }, Route { folder: "../etc".into(), pattern: "/x/".into() }],
                assets: vec![AssetMap { url_prefix: "/img".into(), repo_path: "public/blog-images".into() }, AssetMap { url_prefix: "/y/".into(), repo_path: "missing/".into() }],
                stylesheets: vec!["styles/main.css".into(), "nope.css".into()],
                ..Default::default()
            },
        );
        assert_eq!(p.routes, vec![Route { folder: "posts".into(), pattern: "/blog/{slug}/".into() }]);
        assert_eq!(p.assets, vec![AssetMap { url_prefix: "/img/".into(), repo_path: "public/blog-images/".into() }]);
        assert_eq!(p.stylesheets, vec!["styles/main.css".to_string()]);
    }
}
