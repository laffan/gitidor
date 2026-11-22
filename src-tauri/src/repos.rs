//! The repositories this install knows about, and the lock that keeps two
//! git operations on the same clone from running at once.

use crate::site::SiteProfile;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RepoRecord {
    pub id: String,
    /// What the card is titled; the repository name unless renamed.
    pub name: String,
    pub owner: String,
    pub repo: String,
    /// Always `https://github.com/<owner>/<repo>.git`, never with a token in it.
    pub remote_url: String,
    /// Where the site is served: GitHub Pages or a custom domain.
    pub public_url: String,
    /// The folders shown in the Files column, repository-relative.
    pub folders: Vec<String>,
    /// Folders shown in the Files column with thumbnails, that files can be
    /// uploaded into (images, PDFs, anything). Never also in `folders`.
    pub upload_folders: Vec<String>,
    pub site: Option<SiteProfile>,
    pub added_at: i64,
    /// When `origin` was last fetched; 0 for never.
    pub last_fetched: i64,
    pub last_pushed: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct RepoList {
    repos: Vec<RepoRecord>,
}

const FILE: &str = "repos.json";

/// One lock for reading and rewriting `repos.json`, so two commands saving
/// different repositories cannot each write back a list without the other's.
fn list_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub fn list() -> Result<Vec<RepoRecord>, String> {
    let _guard = list_lock().lock().map_err(|_| "repos.json lock poisoned")?;
    Ok(crate::store::read_json::<RepoList>(FILE)?.repos)
}

pub fn get(id: &str) -> Result<RepoRecord, String> {
    crate::store::checked_id(id)?;
    list()?.into_iter().find(|r| r.id == id).ok_or_else(|| "That repository is no longer here".into())
}

/// Apply `change` to one record and write the list back, under the lock.
pub fn update<F: FnOnce(&mut RepoRecord)>(id: &str, change: F) -> Result<RepoRecord, String> {
    let _guard = list_lock().lock().map_err(|_| "repos.json lock poisoned")?;
    let mut all = crate::store::read_json::<RepoList>(FILE)?;
    let record = all.repos.iter_mut().find(|r| r.id == id).ok_or("That repository is no longer here")?;
    change(record);
    let out = record.clone();
    crate::store::write_json(FILE, &all, false)?;
    Ok(out)
}

pub fn insert(record: RepoRecord) -> Result<(), String> {
    let _guard = list_lock().lock().map_err(|_| "repos.json lock poisoned")?;
    let mut all = crate::store::read_json::<RepoList>(FILE)?;
    all.repos.push(record);
    crate::store::write_json(FILE, &all, false)
}

pub fn remove(id: &str) -> Result<(), String> {
    let _guard = list_lock().lock().map_err(|_| "repos.json lock poisoned")?;
    let mut all = crate::store::read_json::<RepoList>(FILE)?;
    all.repos.retain(|r| r.id != id);
    crate::store::write_json(FILE, &all, false)
}

pub fn reorder(ids: &[String]) -> Result<(), String> {
    let _guard = list_lock().lock().map_err(|_| "repos.json lock poisoned")?;
    let mut all = crate::store::read_json::<RepoList>(FILE)?;
    all.repos.sort_by_key(|r| ids.iter().position(|id| id == &r.id).unwrap_or(usize::MAX));
    crate::store::write_json(FILE, &all, false)
}

/// The lock for one clone. Every git operation takes it, so a fetch started
/// by opening a repository cannot interleave with a commit started by a click.
pub fn git_lock(id: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let map = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap_or_else(|p| p.into_inner());
    guard.entry(id.to_string()).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
}

/// Who commits: the name and address from Settings, or else the GitHub login
/// and GitHub's no-reply address for it, so a commit never publishes an email
/// nobody chose to publish.
pub fn signature() -> Result<git2::Signature<'static>, String> {
    let settings = crate::settings::load().unwrap_or_default();
    let login = crate::secrets::github_login();
    let name = if !settings.git.author_name.trim().is_empty() {
        settings.git.author_name.trim().to_string()
    } else if !login.is_empty() {
        login.clone()
    } else {
        "gitidor".to_string()
    };
    let email = if !settings.git.author_email.trim().is_empty() {
        settings.git.author_email.trim().to_string()
    } else if !login.is_empty() {
        format!("{login}@users.noreply.github.com")
    } else {
        "gitidor@users.noreply.github.com".to_string()
    };
    git2::Signature::now(&name, &email).map_err(|e| e.message().to_string())
}
