//! Where everything gitidor keeps lives, and the two guards every path goes
//! through on its way in.
//!
//! ```text
//! <app data dir>/
//!   repos.json      the repositories, their folders and site profiles
//!   settings.json   appearance, commit defaults, AI provider and model
//!   secrets.json    the GitHub token and AI keys (0600; never sent to the webview)
//!   clones/<id>/    one full clone per repository
//! ```
//!
//! The root comes from Tauri's `app_data_dir`, set once at startup, rather
//! than from a home-directory crate: on iOS the only writable place is the
//! app's own container, and Tauri already knows where that is. Tests point it
//! at a temporary directory with [`set_root_for_tests`].

use serde::{de::DeserializeOwned, Serialize};
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

static ROOT: OnceLock<PathBuf> = OnceLock::new();

pub fn set_root(path: PathBuf) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| format!("Cannot create {}: {e}", path.display()))?;
    ROOT.set(path).map_err(|_| "Storage root was already set".to_string())
}

pub fn root() -> Result<PathBuf, String> {
    ROOT.get().cloned().ok_or_else(|| "Storage is not ready yet".to_string())
}

pub fn clones_dir() -> Result<PathBuf, String> {
    let dir = root()?.join("clones");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn clone_dir(id: &str) -> Result<PathBuf, String> {
    Ok(clones_dir()?.join(checked_id(id)?))
}

/// A repository id, as this app makes them: short, lowercase, alphanumeric.
///
/// Checked wherever one arrives from the webview, because it becomes a
/// directory name and — in the preview scheme — part of a host name.
pub fn checked_id(id: &str) -> Result<&str, String> {
    if !id.is_empty() && id.len() <= 32 && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()) {
        Ok(id)
    } else {
        Err(format!("{id} is not a repository id"))
    }
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..10].to_string()
}

/// A path inside a repository, as the webview names one.
///
/// Only plain components: no `..`, no root, no drive prefix. Every path that
/// crosses the IPC boundary and is joined to a clone goes through here,
/// because the alternative is trusting a string to stay inside a directory
/// the app is about to write to or delete from.
pub fn safe_relative(rel: &str) -> Result<PathBuf, String> {
    let trimmed = rel.trim().trim_start_matches('/');
    if trimmed.is_empty() {
        return Ok(PathBuf::new());
    }
    let path = Path::new(trimmed);
    for part in path.components() {
        match part {
            Component::Normal(_) => {}
            _ => return Err(format!("Unsafe path: {rel}")),
        }
    }
    Ok(path.to_path_buf())
}

/// A repository-relative path with forward slashes, whatever the platform.
pub fn rel_string(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

pub fn read_json<T: DeserializeOwned + Default>(name: &str) -> Result<T, String> {
    let path = root()?.join(name);
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{name} could not be read: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(format!("{name} could not be read: {e}")),
    }
}

/// Written beside the target and renamed over it, so a crash mid-write leaves
/// the previous file rather than half of a new one.
pub fn write_json<T: Serialize>(name: &str, value: &T, private: bool) -> Result<(), String> {
    let path = root()?.join(name);
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| format!("Cannot write {name}: {e}"))?;
    if private {
        restrict(&tmp);
    }
    std::fs::rename(&tmp, &path).map_err(|e| format!("Cannot write {name}: {e}"))
}

#[cfg(unix)]
fn restrict(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict(_path: &Path) {}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_cannot_leave_the_repository() {
        assert!(safe_relative("posts/a.md").is_ok());
        assert!(safe_relative("/posts/a.md").is_ok());
        assert_eq!(safe_relative("").unwrap(), PathBuf::new());
        assert!(safe_relative("../etc/passwd").is_err());
        assert!(safe_relative("posts/../../x").is_err());
        // An interior `.` is dropped by `components()`, so it stays inside.
        assert!(safe_relative("posts/./a.md").is_ok());
    }

    #[test]
    fn ids_are_checked_before_they_become_directories() {
        assert!(checked_id("abc123").is_ok());
        assert!(checked_id("ABC").is_err());
        assert!(checked_id("a/b").is_err());
        assert!(checked_id("").is_err());
        assert_eq!(new_id().len(), 10);
        assert!(checked_id(&new_id()).is_ok());
    }
}
