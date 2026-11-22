//! The Tauri command surface. Every frontend call lands here and is handed to
//! one of the modules below; nothing here does work of its own beyond
//! choosing a thread and taking a lock.
//!
//! Every command that touches disk or network runs on a blocking thread:
//! libgit2 and `ureq` are both blocking, and the webview's main thread is the
//! one that paints.

mod ai;
mod events;
mod files;
mod frontmatter;
mod github_api;
mod gitops;
mod http;
mod livecheck;
mod remote;
mod repos;
mod scheme;
mod secrets;
mod settings;
mod site;
mod store;

use base64::Engine;
use repos::RepoRecord;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};
use tauri::{AppHandle, Emitter, Manager};

type Res<T> = Result<T, String>;

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Res<T> + Send + 'static) -> Res<T> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

/// Every failure reaches the console, whichever command it came from.
fn reported<T>(source: &'static str, result: Res<T>) -> Res<T> {
    if let Err(message) = &result {
        events::log(events::Level::Error, source, message.clone());
    }
    result
}

/// Run `work` against one repository's clone with its git lock held.
async fn with_repo<T: Send + 'static>(
    id: String,
    work: impl FnOnce(&RepoRecord, &git2::Repository) -> Res<T> + Send + 'static,
) -> Res<T> {
    blocking(move || {
        let _scope = events::scope(&id);
        let record = repos::get(&id)?;
        let lock = repos::git_lock(&id);
        let _guard = lock.lock().map_err(|_| "Another git operation failed part-way; restart the app.")?;
        let repo = gitops::open(&store::clone_dir(&id)?)?;
        reported("git", work(&record, &repo))
    })
    .await
}

// ── platform, settings, secrets ─────────────────────────────────────────────

#[tauri::command]
fn platform() -> &'static str {
    std::env::consts::OS
}

#[tauri::command]
async fn get_settings() -> Res<settings::Settings> {
    blocking(settings::load).await
}

#[tauri::command]
async fn save_settings(settings: settings::Settings) -> Res<()> {
    blocking(move || settings::save(&settings)).await
}

#[tauri::command]
async fn secret_status() -> Res<secrets::SecretStatus> {
    blocking(secrets::status).await
}

/// Check a pasted token with GitHub and keep it, with the login it belongs to.
#[tauri::command]
async fn github_sign_in(token: String) -> Res<secrets::SecretStatus> {
    blocking(move || {
        let token = token.trim().to_string();
        if token.is_empty() {
            return Err("Paste a token first".into());
        }
        let login = reported("github", github_api::whoami(&token))?;
        events::info("github", format!("Signed in to GitHub as {login}"));
        let mut s = secrets::load()?;
        s.github_token = token;
        s.github_login = login;
        secrets::save(&s)?;
        secrets::status()
    })
    .await
}

#[tauri::command]
async fn github_sign_out() -> Res<secrets::SecretStatus> {
    blocking(|| {
        let mut s = secrets::load()?;
        s.github_token.clear();
        s.github_login.clear();
        secrets::save(&s)?;
        events::info("github", "Signed out of GitHub; the token was deleted from this device");
        secrets::status()
    })
    .await
}

/// Save (or, with an empty key, remove) an AI provider's key.
#[tauri::command]
async fn set_ai_key(provider: String, key: String) -> Res<secrets::SecretStatus> {
    blocking(move || {
        let mut s = secrets::load()?;
        match provider.as_str() {
            "anthropic" => s.anthropic_key = key.trim().to_string(),
            "openai" => s.openai_key = key.trim().to_string(),
            other => return Err(format!("{other} is not a provider gitidor knows")),
        }
        secrets::save(&s)?;
        events::info("ai", format!("{} key {}", if provider == "openai" { "OpenAI" } else { "Anthropic" }, if key.trim().is_empty() { "removed" } else { "saved" }));
        secrets::status()
    })
    .await
}

#[tauri::command]
async fn test_ai_key(provider: String) -> Res<ai::KeyTest> {
    blocking(move || {
        let result = reported("ai", ai::test_key(&provider).map_err(|e| secrets::redact(&e)));
        if let Ok(test) = &result {
            events::info("ai", format!("{} key works; {} models available", if provider == "openai" { "OpenAI" } else { "Anthropic" }, test.models.len()));
        }
        result
    })
    .await
}

// ── GitHub ──────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepoCheck {
    clone_url: String,
    #[serde(flatten)]
    info: github_api::RepoInfo,
}

/// The Add Repo sheet's "Test access": can this repository be reached, can
/// it be pushed to, which branches does it have, where is it published.
#[tauri::command]
async fn github_check_repo(address: String) -> Res<RepoCheck> {
    blocking(move || {
        let addr = reported("github", remote::parse(&address))?;
        let token = secrets::github_token();
        events::info("github", format!("Checking access to {}/{}", addr.owner, addr.repo));
        let info = reported("github", github_api::repo_info(token.as_deref(), &addr.owner, &addr.repo))?;
        events::info(
            "github",
            format!(
                "{}: {}, {}, {} branch{}, published at {}",
                info.full_name,
                if info.private { "private" } else { "public" },
                if info.can_push { "you can push" } else { "read-only" },
                info.branches.len(),
                if info.branches.len() == 1 { "" } else { "es" },
                info.pages_url
            ),
        );
        Ok(RepoCheck { clone_url: addr.clone_url(), info })
    })
    .await
}

#[tauri::command]
async fn github_list_repos() -> Res<Vec<github_api::RepoSummary>> {
    blocking(|| {
        let token = secrets::github_token().ok_or("Sign in under Settings → GitHub to list your repositories.")?;
        github_api::list_repos(&token)
    })
    .await
}

// ── repositories ────────────────────────────────────────────────────────────

#[tauri::command]
async fn list_repos() -> Res<Vec<RepoRecord>> {
    blocking(repos::list).await
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloneProgress {
    request_id: String,
    received: usize,
    total: usize,
    bytes: usize,
}

/// Clone a repository and remember it. The one step that needs the network
/// before anything else works; everything after it can happen offline.
#[tauri::command]
async fn add_repo(app: AppHandle, request_id: String, address: String, public_url: String, branch: String) -> Res<RepoRecord> {
    blocking(move || {
        let addr = reported("git", remote::parse(&address))?;
        let id = store::new_id();
        let _scope = events::scope(&id);
        let dest = store::clone_dir(&id)?;
        let token = secrets::github_token();
        let emit = |p: gitops::Progress| {
            let _ = app.emit(
                "clone-progress",
                CloneProgress { request_id: request_id.clone(), received: p.received, total: p.total, bytes: p.bytes },
            );
        };
        let branch = if branch.trim().is_empty() { None } else { Some(remote::checked_branch(&branch)?) };
        reported("git", gitops::clone(&addr.clone_url(), branch.as_deref(), &dest, token.as_deref(), &emit))?;

        let profile = site::detect(&dest);
        events::info("app", describe_profile(&profile));
        // A CNAME found in the clone beats the conventional github.io guess
        // the sheet may have prefilled, but never an address somebody typed.
        let typed = public_url.trim();
        let public_url = if !typed.is_empty() && !(typed == addr.default_pages_url() && !profile.public_url_hint.is_empty()) {
            typed.to_string()
        } else if !profile.public_url_hint.is_empty() {
            profile.public_url_hint.clone()
        } else {
            addr.default_pages_url()
        };
        let now = store::now_ms();
        let record = RepoRecord {
            id,
            name: addr.repo.clone(),
            owner: addr.owner.clone(),
            repo: addr.repo.clone(),
            remote_url: addr.clone_url(),
            public_url,
            folders: Vec::new(),
            upload_folders: Vec::new(),
            site: Some(profile),
            added_at: now,
            last_fetched: now,
            last_pushed: 0,
        };
        repos::insert(record.clone())?;
        Ok(record)
    })
    .await
}

#[tauri::command]
async fn remove_repo(id: String, delete_files: bool) -> Res<()> {
    blocking(move || {
        store::checked_id(&id)?;
        let lock = repos::git_lock(&id);
        let _guard = lock.lock().map_err(|_| "lock poisoned")?;
        repos::remove(&id)?;
        if delete_files {
            let dir = store::clone_dir(&id)?;
            if dir.exists() {
                std::fs::remove_dir_all(&dir).map_err(|e| format!("The local copy could not be deleted: {e}"))?;
            }
        }
        Ok(())
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepoPatch {
    name: Option<String>,
    public_url: Option<String>,
}

#[tauri::command]
async fn update_repo(id: String, patch: RepoPatch) -> Res<RepoRecord> {
    blocking(move || {
        repos::update(&id, |r| {
            if let Some(name) = patch.name.filter(|n| !n.trim().is_empty()) {
                r.name = name.trim().to_string();
            }
            if let Some(url) = patch.public_url {
                r.public_url = url.trim().to_string();
            }
        })
    })
    .await
}

#[tauri::command]
async fn reorder_repos(ids: Vec<String>) -> Res<()> {
    blocking(move || repos::reorder(&ids)).await
}

// ── git ─────────────────────────────────────────────────────────────────────

#[tauri::command]
async fn repo_status(id: String) -> Res<gitops::RepoStatus> {
    with_repo(id, |_, repo| gitops::status(repo)).await
}

#[tauri::command]
async fn repo_fetch(id: String) -> Res<gitops::RepoStatus> {
    let rid = id.clone();
    let status = with_repo(id, |_, repo| {
        let branch = gitops::current_branch(repo);
        gitops::fetch(repo, Some(&branch), secrets::github_token().as_deref())?;
        gitops::status(repo)
    })
    .await?;
    let _ = blocking(move || repos::update(&rid, |r| r.last_fetched = store::now_ms())).await;
    Ok(status)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PullReport {
    outcome: gitops::PullOutcome,
    status: gitops::RepoStatus,
}

#[tauri::command]
async fn repo_pull(id: String) -> Res<PullReport> {
    let rid = id.clone();
    let report = with_repo(id, |_, repo| {
        let outcome = gitops::pull(repo, secrets::github_token().as_deref(), &repos::signature()?)?;
        Ok(PullReport { outcome, status: gitops::status(repo)? })
    })
    .await?;
    let _ = blocking(move || repos::update(&rid, |r| r.last_fetched = store::now_ms())).await;
    Ok(report)
}

#[tauri::command]
async fn repo_commit(id: String, paths: Vec<String>, message: String) -> Res<gitops::RepoStatus> {
    with_repo(id, move |_, repo| {
        gitops::commit(repo, &paths, &message, &repos::signature()?)?;
        gitops::status(repo)
    })
    .await
}

#[tauri::command]
async fn repo_push(id: String) -> Res<gitops::RepoStatus> {
    let rid = id.clone();
    let status = with_repo(id, |_, repo| {
        gitops::push(repo, secrets::github_token().as_deref())?;
        gitops::status(repo)
    })
    .await?;
    let _ = blocking(move || repos::update(&rid, |r| r.last_pushed = store::now_ms())).await;
    Ok(status)
}

/// Branches, optionally after fetching every branch from origin.
#[tauri::command]
async fn repo_branches(id: String, fetch: bool) -> Res<gitops::Branches> {
    with_repo(id, move |_, repo| {
        if fetch {
            // Offline is fine: list what is known locally.
            let _ = gitops::fetch(repo, None, secrets::github_token().as_deref());
        }
        gitops::branches(repo)
    })
    .await
}

#[tauri::command]
async fn repo_checkout(id: String, branch: String, create: bool) -> Res<gitops::RepoStatus> {
    with_repo(id, move |_, repo| {
        gitops::checkout(repo, &branch, create)?;
        gitops::status(repo)
    })
    .await
}

#[tauri::command]
async fn repo_discard(id: String, path: String) -> Res<gitops::RepoStatus> {
    with_repo(id, move |_, repo| {
        gitops::discard(repo, &path)?;
        gitops::status(repo)
    })
    .await
}

#[tauri::command]
async fn repo_diff(id: String, path: String) -> Res<String> {
    with_repo(id, move |_, repo| gitops::diff(repo, &path)).await
}

#[tauri::command]
async fn repo_log(id: String, limit: usize) -> Res<Vec<gitops::CommitInfo>> {
    with_repo(id, move |_, repo| gitops::log(repo, limit.clamp(1, 200))).await
}

/// One file as a commit has it, or `null` when that commit does not.
#[tauri::command]
async fn repo_show(id: String, rev: String, path: String) -> Res<Option<String>> {
    with_repo(id, move |_, repo| gitops::show(repo, &rev, &path)).await
}

#[tauri::command]
async fn repo_rollback_plan(id: String, to: String) -> Res<gitops::RollbackPlan> {
    with_repo(id, move |_, repo| gitops::rollback_plan(repo, &to)).await
}

/// Roll back as the plan the person saw said; `head` and `target` are the
/// plan's, and a mismatch refuses rather than losing something unseen.
#[tauri::command]
async fn repo_rollback(id: String, to: String, head: String, target: String) -> Res<gitops::RepoStatus> {
    with_repo(id, move |_, repo| {
        gitops::rollback(repo, &to, &head, &target)?;
        gitops::status(repo)
    })
    .await
}

// ── folders and files ───────────────────────────────────────────────────────

#[tauri::command]
async fn list_dirs(id: String) -> Res<Vec<files::DirInfo>> {
    blocking(move || Ok(files::list_dirs(&store::clone_dir(&id)?))).await
}

#[tauri::command]
async fn set_folders(id: String, folders: Vec<String>) -> Res<RepoRecord> {
    blocking(move || {
        let clean = files::existing_folders(&store::clone_dir(&id)?, &folders)?;
        // A folder is one kind or the other: becoming a content folder takes
        // it out of the upload folders.
        repos::update(&id, |r| {
            r.upload_folders.retain(|f| !clean.contains(f));
            r.folders = clean;
        })
    })
    .await
}

#[tauri::command]
async fn set_upload_folders(id: String, folders: Vec<String>) -> Res<RepoRecord> {
    blocking(move || {
        let clean = files::existing_folders(&store::clone_dir(&id)?, &folders)?;
        repos::update(&id, |r| {
            r.folders.retain(|f| !clean.contains(f));
            r.upload_folders = clean;
        })
    })
    .await
}

#[tauri::command]
async fn list_uploads(id: String, folder: String) -> Res<Vec<files::UploadEntry>> {
    blocking(move || files::list_uploads(&store::clone_dir(&id)?, &folder, &change_map(&id))).await
}

fn change_map(id: &str) -> HashMap<String, String> {
    let Ok(dir) = store::clone_dir(id) else { return HashMap::new() };
    let Ok(repo) = gitops::open(&dir) else { return HashMap::new() };
    gitops::changes(&repo).unwrap_or_default().into_iter().map(|c| (c.path, c.kind)).collect()
}

#[tauri::command]
async fn list_folder(id: String, folder: String) -> Res<Vec<files::FileEntry>> {
    blocking(move || {
        let record = repos::get(&id)?;
        let root = store::clone_dir(&id)?;
        files::list_folder(&root, &folder, record.site.as_ref(), &change_map(&id))
    })
    .await
}

#[tauri::command]
async fn read_file(id: String, path: String) -> Res<String> {
    blocking(move || files::read(&store::clone_dir(&id)?, &path)).await
}

#[tauri::command]
async fn write_file(id: String, path: String, content: String) -> Res<()> {
    blocking(move || files::write(&store::clone_dir(&id)?, &path, &content)).await
}

#[tauri::command]
async fn create_file(id: String, folder: String, name: String, content: String) -> Res<String> {
    blocking(move || files::create(&store::clone_dir(&id)?, &folder, &name, &content)).await
}

#[tauri::command]
async fn rename_file(id: String, from: String, to: String) -> Res<()> {
    blocking(move || files::rename(&store::clone_dir(&id)?, &from, &to)).await
}

#[tauri::command]
async fn delete_file(id: String, path: String) -> Res<()> {
    blocking(move || files::delete(&store::clone_dir(&id)?, &path)).await
}

/// Save a pasted or dropped image, or an uploaded file, into the repository.
/// Base64 rather than a JSON array of numbers, which is several times larger
/// for the same bytes.
#[tauri::command]
async fn import_asset(id: String, dir: String, name: String, data: String) -> Res<String> {
    blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).map_err(|e| format!("{name} could not be read: {e}"))?;
        files::import_asset(&store::clone_dir(&id)?, &dir, &name, &bytes)
    })
    .await
}

// ── site structure ──────────────────────────────────────────────────────────

/// Work out the site's structure again, by rule or with the AI provider, and
/// try its routes on the live site. The result is saved on the repository
/// either way.
#[tauri::command]
async fn detect_site(id: String, use_ai: bool) -> Res<site::SiteProfile> {
    blocking(move || {
        let record = repos::get(&id)?;
        let root = store::clone_dir(&id)?;
        let heuristic = site::detect(&root);
        let _scope = events::scope(&id);
        let live = livecheck::Site::from_public_url(&record.public_url);
        let unpublished = unpublished(&id);
        let profile = if use_ai {
            let live = live.as_ref().map(|site| ai::Live { site, unpublished: &unpublished });
            reported("ai", ai::detect_site(&root, &heuristic, &record.folders, live).map_err(|e| secrets::redact(&e)))?
        } else {
            let mut profile = heuristic;
            if let Some(site) = &live {
                check_routes(&root, &mut profile, site, &record.folders, &unpublished);
            }
            profile
        };
        events::info(if use_ai { "ai" } else { "app" }, describe_profile(&profile));
        repos::update(&id, |r| r.site = Some(profile.clone()))?;
        Ok(profile)
    })
    .await
}

/// Try the saved profile's routes on the live site, without changing them.
#[tauri::command]
async fn check_site(id: String) -> Res<site::SiteProfile> {
    blocking(move || {
        let record = repos::get(&id)?;
        let root = store::clone_dir(&id)?;
        let _scope = events::scope(&id);
        let mut profile = record.site.clone().unwrap_or_else(|| site::detect(&root));
        let site = livecheck::Site::from_public_url(&record.public_url).ok_or("This repository has no public URL to check against. Add one in its settings.")?;
        check_routes(&root, &mut profile, &site, &record.folders, &unpublished(&id));
        repos::update(&id, |r| r.site = Some(profile.clone()))?;
        Ok(profile)
    })
    .await
}

fn check_routes(root: &std::path::Path, profile: &mut site::SiteProfile, live: &livecheck::Site, folders: &[String], unpublished: &HashSet<String>) {
    profile.checks = livecheck::check(root, profile, live, folders, unpublished);
    profile.checked_at = store::now_ms();
    for c in &profile.checks {
        let line = format!("{} → {}: {}", c.folder, if c.pattern.is_empty() { "no route" } else { &c.pattern }, c.message);
        match c.outcome.as_str() {
            "ok" => events::info("preview", line),
            "unchecked" => events::debug("preview", line),
            _ => events::warn("preview", line),
        }
    }
}

/// Files GitHub does not have yet — changed here, or in commits not pushed —
/// which the live site cannot show. Read under the git lock, then let go,
/// so a commit is not held up by the live site's answers.
fn unpublished(id: &str) -> HashSet<String> {
    let lock = repos::git_lock(id);
    let Ok(_guard) = lock.lock() else { return HashSet::new() };
    let Ok(repo) = store::clone_dir(id).and_then(|d| gitops::open(&d)) else { return HashSet::new() };
    let Ok(status) = gitops::status(&repo) else { return HashSet::new() };
    status.changes.into_iter().map(|c| c.path).chain(status.unpushed).collect()
}

#[tauri::command]
async fn save_site(id: String, profile: site::SiteProfile) -> Res<RepoRecord> {
    blocking(move || {
        // A hand edit that cannot be read is refused with the reason, rather
        // than saved without the route.
        for route in &profile.routes {
            let problems = site::route_problems(route);
            if !problems.is_empty() {
                return Err(format!("{}: {}", if route.folder.is_empty() { "(root)" } else { &route.folder }, problems.join("; ")));
            }
        }
        let root = store::clone_dir(&id)?;
        let mut clean = site::sanitize(&root, profile);
        clean.source = "manual".into();
        repos::update(&id, |r| r.site = Some(clean))
    })
    .await
}

/// Which file a page of the live site was built from, if any.
///
/// `url_path` is the path the preview frame is showing, base path included;
/// it is compared against every post's computed URL in one normalised form.
#[tauri::command]
async fn site_lookup(id: String, url_path: String) -> Res<Option<String>> {
    blocking(move || {
        let record = repos::get(&id)?;
        let Some(profile) = record.site.as_ref() else { return Ok(None) };
        let base = remote::split_public_url(&record.public_url).map(|(_, b)| b).unwrap_or_default();
        let below_base = url_path.strip_prefix(&base).filter(|_| !base.is_empty()).unwrap_or(&url_path);
        let wanted = site::normalize_url_path(below_base);
        let root = store::clone_dir(&id)?;
        let mut folders: BTreeSet<String> = record.folders.iter().cloned().collect();
        folders.extend(profile.routes.iter().map(|r| r.folder.clone()).filter(|f| !f.is_empty()));
        let empty = HashMap::new();
        for folder in folders {
            let Ok(list) = files::list_folder(&root, &folder, Some(profile), &empty) else { continue };
            if let Some(hit) = list.into_iter().find(|f| f.url.as_deref().map(site::normalize_url_path).as_deref() == Some(wanted.as_str())) {
                return Ok(Some(hit.path));
            }
        }
        Ok(None)
    })
    .await
}

/// One line saying what a site profile found, for the console.
fn describe_profile(p: &site::SiteProfile) -> String {
    let routes: Vec<String> = p.routes.iter().map(|r| format!("{} → {}", r.folder, r.pattern)).collect();
    let assets = p.assets.iter().filter(|a| a.url_prefix != "/").count();
    format!(
        "Site structure ({}{}): {}; {} image folder{} mapped",
        if p.generator == "unknown" { "generator not recognised" } else { &p.generator },
        match p.source.as_str() { "ai" => ", from AI", "manual" => ", edited", _ => ", from config" },
        if routes.is_empty() { "no post folders".to_string() } else { routes.join(", ") },
        assets,
        if assets == 1 { "" } else { "s" },
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .register_asynchronous_uri_scheme_protocol("gitidor", |_ctx, request, responder| {
            tauri::async_runtime::spawn_blocking(move || responder.respond(scheme::handle(request)));
        })
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            store::set_root(dir)?;
            events::init(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            platform,
            get_settings,
            save_settings,
            secret_status,
            github_sign_in,
            github_sign_out,
            set_ai_key,
            test_ai_key,
            github_check_repo,
            github_list_repos,
            list_repos,
            add_repo,
            remove_repo,
            update_repo,
            reorder_repos,
            repo_status,
            repo_fetch,
            repo_pull,
            repo_commit,
            repo_push,
            repo_branches,
            repo_checkout,
            repo_discard,
            repo_diff,
            repo_log,
            repo_show,
            repo_rollback_plan,
            repo_rollback,
            list_dirs,
            set_folders,
            set_upload_folders,
            list_uploads,
            list_folder,
            read_file,
            write_file,
            create_file,
            rename_file,
            delete_file,
            import_asset,
            detect_site,
            check_site,
            save_site,
            site_lookup,
        ])
        .run(tauri::generate_context!())
        .expect("error while running gitidor");
}
