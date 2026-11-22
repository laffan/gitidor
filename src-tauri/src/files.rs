//! The files inside a clone: what the folder picker offers, what a folder
//! lists, and reading and writing one file.
//!
//! Every path arrives from the webview and goes through `safe_relative` before
//! it is joined to the clone. Writes go beside the target and are renamed over
//! it, so an editor autosave interrupted by the app being killed — which iOS
//! does without asking — leaves the previous version rather than half a file.

use crate::frontmatter;
use crate::site::{self, SiteProfile};
use crate::store::{rel_string, safe_relative};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirInfo {
    pub path: String,
    pub depth: usize,
    /// Markdown files directly inside.
    pub markdown: usize,
    /// Markdown files anywhere below.
    pub markdown_total: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub title: String,
    /// `YYYY-MM-DD`, from frontmatter or the filename, else empty.
    pub date: String,
    pub draft: bool,
    /// The published URL path, when the site profile can say.
    pub url: Option<String>,
    /// `modified`, `added`, `deleted`, … from git, else empty.
    pub change: String,
    pub modified: i64,
}

const SKIP: &[&str] = &["node_modules", "_site", "dist", ".git", ".github", "vendor", "target"];
const MAX_DIRS: usize = 3000;

/// Every directory in the clone (not the ignored ones), for the folder picker.
pub fn list_dirs(root: &Path) -> Vec<DirInfo> {
    let mut out = Vec::new();
    collect_dirs(root, root, 0, &mut out);
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

fn collect_dirs(root: &Path, dir: &Path, depth: usize, out: &mut Vec<DirInfo>) -> usize {
    if out.len() >= MAX_DIRS || depth > 6 {
        return 0;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let mut direct = 0;
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        if path.is_dir() {
            if !name.starts_with('.') && !SKIP.contains(&name.as_str()) {
                subdirs.push(path);
            }
        } else if site::is_markdown(&name) {
            direct += 1;
        }
    }
    let index = out.len();
    if dir != root {
        out.push(DirInfo { path: rel_string(root, dir), depth, markdown: direct, markdown_total: 0 });
    }
    let mut total = direct;
    for sub in subdirs {
        total += collect_dirs(root, &sub, depth + 1, out);
    }
    if dir != root {
        out[index].markdown_total = total;
    }
    total
}

/// The markdown files under a folder, newest first.
pub fn list_folder(root: &Path, folder: &str, profile: Option<&SiteProfile>, changes: &HashMap<String, String>) -> Result<Vec<FileEntry>, String> {
    let base = root.join(safe_relative(folder)?);
    if !base.is_dir() {
        return Err(format!("{folder} is not in this repository any more"));
    }
    let mut paths = Vec::new();
    collect_markdown(&base, 0, &mut paths);
    let mut out: Vec<FileEntry> = paths
        .into_iter()
        .map(|path| {
            let rel = rel_string(root, &path);
            let text = read_head(&path);
            let front = frontmatter::parse(&text);
            let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let stem = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(&name).to_string();
            let date = front
                .date()
                .or_else(|| frontmatter::ymd_prefix(&stem))
                .map(|(y, m, d)| format!("{y}-{m}-{d}"))
                .unwrap_or_default();
            let title = front
                .get("title")
                .map(str::to_string)
                .or_else(|| first_heading(&text))
                .unwrap_or_else(|| site::strip_date(&stem).trim_matches('-').replace(['-', '_'], " "));
            let modified = std::fs::metadata(&path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            FileEntry {
                url: profile.and_then(|p| site::url_for(p, &rel, &front)),
                change: changes.get(&rel).cloned().unwrap_or_default(),
                draft: front.is_draft(),
                path: rel,
                name,
                title,
                date,
                modified,
            }
        })
        .collect();
    out.sort_by(|a, b| b.date.cmp(&a.date).then_with(|| b.name.cmp(&a.name)));
    Ok(out)
}

fn collect_markdown(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 6 || out.len() > 20_000 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if !name.starts_with('.') && !SKIP.contains(&name.as_str()) {
                collect_markdown(&path, depth + 1, out);
            }
        } else if site::is_markdown(&name) {
            out.push(path);
        }
    }
}

/// The first few kilobytes — enough for any frontmatter worth listing by.
fn read_head(path: &Path) -> String {
    use std::io::Read;
    let mut buf = vec![0u8; 8192];
    let n = std::fs::File::open(path).and_then(|mut f| f.read(&mut buf)).unwrap_or(0);
    buf.truncate(n);
    String::from_utf8_lossy(&buf).to_string()
}

fn first_heading(text: &str) -> Option<String> {
    text.lines().find_map(|l| l.strip_prefix("# ").map(|h| h.trim().to_string())).filter(|h| !h.is_empty())
}

pub fn read(root: &Path, rel: &str) -> Result<String, String> {
    let path = root.join(safe_relative(rel)?);
    let bytes = std::fs::read(&path).map_err(|e| format!("Cannot open {rel}: {e}"))?;
    String::from_utf8(bytes).map_err(|_| format!("{rel} is not UTF-8 text"))
}

pub fn write(root: &Path, rel: &str, content: &str) -> Result<(), String> {
    let rel_path = safe_relative(rel)?;
    if rel_path.as_os_str().is_empty() {
        return Err("No file named".into());
    }
    let path = root.join(&rel_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_file_name(format!(".{}.gitidor-tmp", path.file_name().unwrap_or_default().to_string_lossy()));
    std::fs::write(&tmp, content).map_err(|e| format!("Cannot save {rel}: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Cannot save {rel}: {e}"))
}

/// A new file in `folder`, refusing to overwrite one that is there.
pub fn create(root: &Path, folder: &str, name: &str, content: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.starts_with('.') {
        return Err(format!("{name} is not a file name"));
    }
    let name = if site::is_markdown(name) { name.to_string() } else { format!("{name}.md") };
    let rel = if folder.trim_matches('/').is_empty() { name } else { format!("{}/{name}", folder.trim_matches('/')) };
    let path = root.join(safe_relative(&rel)?);
    if path.exists() {
        return Err(format!("{rel} already exists"));
    }
    write(root, &rel, content)?;
    Ok(rel)
}

pub fn rename(root: &Path, from: &str, to: &str) -> Result<(), String> {
    let src = root.join(safe_relative(from)?);
    let dst = root.join(safe_relative(to)?);
    if dst.exists() {
        return Err(format!("{to} already exists"));
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&src, &dst).map_err(|e| format!("Cannot rename {from}: {e}"))
}

pub fn delete(root: &Path, rel: &str) -> Result<(), String> {
    let rel_path = safe_relative(rel)?;
    let path = root.join(&rel_path);
    if !path.is_file() {
        return Err(format!("{rel} is not a file"));
    }
    std::fs::remove_file(&path).map_err(|e| format!("Cannot delete {rel}: {e}"))
}

/// Save image bytes (pasted or dropped into the editor) into the repository.
/// Answers the repository path it was saved at, with a number added to the
/// name if something is already there.
pub fn import_asset(root: &Path, dir: &str, name: &str, bytes: &[u8]) -> Result<String, String> {
    let clean: String = name
        .trim()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '-' })
        .collect();
    let clean = clean.trim_matches(['-', '.']).to_string();
    if clean.is_empty() {
        return Err("The image has no usable name".into());
    }
    let dir_rel = safe_relative(dir)?;
    let (stem, ext) = clean.rsplit_once('.').map(|(s, e)| (s.to_string(), format!(".{e}"))).unwrap_or((clean.clone(), String::new()));
    let mut candidate = clean.clone();
    let mut n = 2;
    while root.join(&dir_rel).join(&candidate).exists() {
        candidate = format!("{stem}-{n}{ext}");
        n += 1;
    }
    let rel = rel_string(root, &root.join(&dir_rel).join(&candidate));
    let path = root.join(safe_relative(&rel)?);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, bytes).map_err(|e| format!("Cannot save the image: {e}"))?;
    Ok(rel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn repo() -> PathBuf {
        let root = std::env::temp_dir().join(format!("gitidor-files-{}-{}", std::process::id(), crate::store::new_id()));
        fs::create_dir_all(root.join("posts/2020")).unwrap();
        fs::create_dir_all(root.join("node_modules/x")).unwrap();
        fs::write(root.join("posts/2010-03-14--crickets.md"), "---\ntitle: Crickets\ndate: 2010-03-14\n---\nx").unwrap();
        fs::write(root.join("posts/2020/2020-05-01-spring.md"), "# Spring\n").unwrap();
        fs::write(root.join("posts/untitled-note.md"), "no title").unwrap();
        fs::write(root.join("node_modules/x/readme.md"), "x").unwrap();
        root
    }

    #[test]
    fn a_folder_lists_its_posts_newest_first_with_titles() {
        let root = repo();
        let mut changes = HashMap::new();
        changes.insert("posts/2010-03-14--crickets.md".to_string(), "modified".to_string());
        let list = list_folder(&root, "posts", None, &changes).unwrap();
        let titles: Vec<&str> = list.iter().map(|f| f.title.as_str()).collect();
        assert_eq!(titles, vec!["Spring", "Crickets", "untitled note"]);
        assert_eq!(list[0].date, "2020-05-01");
        assert_eq!(list[1].change, "modified");
    }

    #[test]
    fn the_picker_counts_markdown_and_skips_dependencies() {
        let root = repo();
        let dirs = list_dirs(&root);
        let posts = dirs.iter().find(|d| d.path == "posts").unwrap();
        assert_eq!((posts.markdown, posts.markdown_total), (2, 3));
        assert!(!dirs.iter().any(|d| d.path.starts_with("node_modules")));
    }

    #[test]
    fn files_are_written_created_and_kept_inside() {
        let root = repo();
        write(&root, "posts/new/one.md", "hello").unwrap();
        assert_eq!(read(&root, "posts/new/one.md").unwrap(), "hello");
        assert!(write(&root, "../escape.md", "x").is_err());
        let rel = create(&root, "posts", "second", "x").unwrap();
        assert_eq!(rel, "posts/second.md");
        assert!(create(&root, "posts", "second.md", "x").is_err());
        let img = import_asset(&root, "public/img", "My Photo.JPG", b"x").unwrap();
        assert_eq!(img, "public/img/My-Photo.JPG");
        let again = import_asset(&root, "public/img", "My Photo.JPG", b"y").unwrap();
        assert_eq!(again, "public/img/My-Photo-2.JPG");
    }
}
