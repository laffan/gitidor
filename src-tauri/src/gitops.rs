//! Every git operation the app performs, through libgit2.
//!
//! **Linked, not spawned.** iOS does not let an app create a child process, so
//! running `git` there is impossible; running libgit2 is not. `libgit2-sys`
//! vendors and builds it for whatever target Cargo is pointed at and uses the
//! system TLS stack on Apple targets. This is the approach idlewild-editor
//! takes for publishing, and most of the hard-won details below come from it.
//!
//! **Full clones, never shallow.** libgit2 cannot push from a shallow
//! repository, and the failure it reports reads like somebody else pushed.
//!
//! **Nothing here rewrites history or forces anything.** Pull fast-forwards
//! when it can and makes an ordinary merge commit when both sides moved and
//! the merge is clean; when it is not clean it stops and says which files,
//! leaving the working tree as it was. Push never uses a `+` refspec.
//!
//! **Offline is the normal case.** Status, commit, branch and discard touch
//! only the local clone; fetch, pull and push are the only calls that need a
//! network, and the interface only makes them when asked to.

use git2::build::{CheckoutBuilder, RepoBuilder};
use git2::{
    AutotagOption, BranchType, Cred, CredentialType, Delta, DiffFormat, DiffOptions, FetchOptions, ProxyOptions, PushOptions, RemoteCallbacks, Repository, ResetType, Signature, Sort, Status,
    StatusOptions,
};
use serde::Serialize;
use std::cell::{Cell, RefCell};
use std::path::Path;

use crate::events::{self, size};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub received: usize,
    pub total: usize,
    pub bytes: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    /// `modified`, `added`, `deleted`, `renamed` or `conflicted`.
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub id: String,
    pub short: String,
    pub summary: String,
    pub author: String,
    /// Milliseconds since the epoch.
    pub time: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub branch: String,
    pub head: Option<CommitInfo>,
    /// Commits here that the last-fetched remote branch does not have.
    pub ahead: usize,
    /// Commits on the last-fetched remote branch that are not here.
    pub behind: usize,
    /// Whether `origin/<branch>` exists locally at all. A branch made here and
    /// never pushed has none, and every commit on it counts as ahead.
    pub has_upstream: bool,
    pub changes: Vec<Change>,
    /// Files the commits GitHub does not have yet change, so the live preview
    /// can say which posts are not on the site.
    pub unpushed: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branches {
    pub current: String,
    pub local: Vec<String>,
    /// Branches on origin with no local branch of the same name.
    pub remote_only: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum PullOutcome {
    UpToDate,
    NoUpstream,
    FastForward { commits: usize },
    Merged { commits: usize },
}

fn err(e: git2::Error) -> String {
    msg(&e)
}

fn msg(e: &git2::Error) -> String {
    crate::secrets::redact(e.message())
}

// ── credentials ─────────────────────────────────────────────────────────────

/// How the token reaches libgit2: a credentials callback answering
/// `x-access-token:<token>`, GitHub's scheme for a token over HTTPS. Never in
/// a URL, so never in `.git/config` and never in an error message.
///
/// **Asked once.** libgit2 calls this again every time the server refuses the
/// answer, and a callback that keeps giving the same wrong token loops
/// forever. The second ask is a refusal, and is reported as one.
fn callbacks<'a>(token: Option<&'a str>, asked: &'a Cell<u32>) -> RemoteCallbacks<'a> {
    let mut callbacks = RemoteCallbacks::new();
    callbacks.credentials(move |_url, _user, allowed| {
        asked.set(asked.get() + 1);
        match token {
            Some(token) if asked.get() == 1 && allowed.contains(CredentialType::USER_PASS_PLAINTEXT) => {
                Cred::userpass_plaintext("x-access-token", token)
            }
            Some(_) => Err(git2::Error::from_str("GitHub refused the saved token")),
            None => Err(git2::Error::from_str("This repository needs a GitHub token")),
        }
    });
    // What the server says while it works ("remote: Enumerating objects…").
    // Its percentage lines repeat dozens of times; only the settled ones are
    // worth a line in the console.
    callbacks.sideband_progress(|data| {
        for line in String::from_utf8_lossy(data).split(['\r', '\n']).map(str::trim).filter(|l| !l.is_empty()) {
            if !line.contains('%') || line.ends_with("done.") {
                events::debug("git", format!("remote: {line}"));
            }
        }
        true
    });
    callbacks
}

/// A proxy if git's config or the environment names one, as `git` itself does.
fn proxy() -> ProxyOptions<'static> {
    let mut options = ProxyOptions::new();
    options.auto();
    options
}

/// A network failure, said in terms of what to do about it.
fn network_failure(e: &git2::Error, token: Option<&str>) -> String {
    let message = msg(e);
    let lower = message.to_ascii_lowercase();
    if lower.contains("needs a github token") {
        return "This repository is private or the address is wrong. Sign in under Settings → GitHub, then try again.".into();
    }
    if lower.contains("refused the saved token") || e.code() == git2::ErrorCode::Auth || lower.contains("401") {
        return "GitHub refused the saved token. It needs Contents read and write on this repository — a fine-grained token has to list it explicitly.".into();
    }
    if lower.contains("403") {
        return "GitHub refused access. The token can read this repository but not write to it.".into();
    }
    if lower.contains("404") || lower.contains("not found") {
        return if token.is_some() {
            "GitHub says that repository is not there, or this token cannot see it.".into()
        } else {
            "That repository was not found. If it is private, sign in under Settings → GitHub first.".into()
        };
    }
    if e.class() == git2::ErrorClass::Net || e.class() == git2::ErrorClass::Ssl || e.class() == git2::ErrorClass::Http {
        return format!("Cannot reach GitHub ({message}). Your changes are safe here; try again when you are online.");
    }
    message
}

// ── clone ───────────────────────────────────────────────────────────────────

/// Clone `url` into `dest`, on `branch` if one is given, else the remote's
/// default. Answers the branch that was checked out.
pub fn clone(
    url: &str,
    branch: Option<&str>,
    dest: &Path,
    token: Option<&str>,
    progress: &dyn Fn(Progress),
) -> Result<String, String> {
    events::info("git", format!("Cloning {}{}", url.trim_end_matches(".git"), branch.filter(|b| !b.is_empty()).map(|b| format!(" ({b})")).unwrap_or_default()));
    let task = events::task("git", "Receiving objects", "objects");
    let received_bytes = Cell::new(0usize);
    let last = Cell::new(0usize);
    let asked = Cell::new(0);
    let mut cbs = callbacks(token, &asked);
    cbs.transfer_progress(|stats| {
        let received = stats.received_objects();
        task.update(received as u64, stats.total_objects() as u64);
        received_bytes.set(stats.received_bytes());
        // Throttled: libgit2 reports every object, and every report is an IPC
        // event the webview has to paint.
        if received == stats.total_objects() || received >= last.get() + 64 {
            last.set(received);
            progress(Progress { received, total: stats.total_objects(), bytes: stats.received_bytes() });
        }
        true
    });
    let mut fetch = FetchOptions::new();
    fetch.remote_callbacks(cbs);
    fetch.proxy_options(proxy());

    let mut builder = RepoBuilder::new();
    builder.fetch_options(fetch);
    if let Some(branch) = branch.filter(|b| !b.is_empty()) {
        builder.branch(branch);
    }
    let repo = builder.clone(url, dest).map_err(|e| {
        let _ = std::fs::remove_dir_all(dest);
        network_failure(&e, token)
    })?;
    task.finish(0, 0);
    let branch = current_branch(&repo);
    events::info("git", format!("Cloned {} on {branch}", size(received_bytes.get() as u64)));
    Ok(branch)
}

pub fn open(path: &Path) -> Result<Repository, String> {
    Repository::open(path).map_err(|e| format!("The local copy could not be opened: {}", err(e)))
}

/// The branch HEAD names, even when it has no commits yet.
pub fn current_branch(repo: &Repository) -> String {
    if let Ok(head) = repo.head() {
        if let Ok(name) = head.shorthand() {
            return name.to_string();
        }
    }
    // An unborn HEAD still names a branch in its symbolic target.
    repo.find_reference("HEAD")
        .ok()
        .and_then(|r| r.symbolic_target().ok().flatten().map(|t| t.trim_start_matches("refs/heads/").to_string()))
        .unwrap_or_else(|| "main".into())
}

// ── status ──────────────────────────────────────────────────────────────────

fn commit_info(commit: &git2::Commit) -> CommitInfo {
    let id = commit.id().to_string();
    CommitInfo {
        short: id[..7.min(id.len())].to_string(),
        id,
        summary: commit.summary().ok().flatten().unwrap_or_default().to_string(),
        author: commit.author().name().unwrap_or_default().to_string(),
        time: commit.time().seconds() * 1000,
    }
}

pub fn changes(repo: &Repository) -> Result<Vec<Change>, String> {
    let mut options = StatusOptions::new();
    options.include_untracked(true).recurse_untracked_dirs(true).include_ignored(false).renames_head_to_index(true);
    let statuses = repo.statuses(Some(&mut options)).map_err(err)?;
    let mut out = Vec::new();
    for entry in statuses.iter() {
        let s = entry.status();
        let Ok(path) = entry.path() else { continue };
        let kind = if s.contains(Status::CONFLICTED) {
            "conflicted"
        } else if s.intersects(Status::WT_NEW | Status::INDEX_NEW) {
            "added"
        } else if s.intersects(Status::WT_DELETED | Status::INDEX_DELETED) {
            "deleted"
        } else if s.intersects(Status::WT_RENAMED | Status::INDEX_RENAMED) {
            "renamed"
        } else if s.intersects(Status::WT_MODIFIED | Status::INDEX_MODIFIED | Status::WT_TYPECHANGE | Status::INDEX_TYPECHANGE) {
            "modified"
        } else {
            continue;
        };
        out.push(Change { path: path.to_string(), kind: kind.into() });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

pub fn status(repo: &Repository) -> Result<RepoStatus, String> {
    let branch = current_branch(repo);
    let head_commit = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let upstream = repo.refname_to_id(&format!("refs/remotes/origin/{branch}")).ok();
    let (ahead, behind) = match (&head_commit, upstream) {
        (Some(local), Some(remote)) => repo.graph_ahead_behind(local.id(), remote).map_err(err)?,
        (Some(local), None) => (count_commits(repo, local.id()), 0),
        (None, _) => (0, 0),
    };
    let unpushed = match (&head_commit, upstream) {
        (Some(local), Some(remote)) if ahead > 0 => repo
            .merge_base(local.id(), remote)
            .ok()
            .map(|base| changed_between(repo, Some(base), local.id()))
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    Ok(RepoStatus {
        branch,
        head: head_commit.as_ref().map(commit_info),
        ahead,
        behind,
        has_upstream: upstream.is_some(),
        changes: changes(repo)?,
        unpushed,
    })
}

/// The paths that differ between two commits' trees (`None`: an empty tree).
fn changed_between(repo: &Repository, from: Option<git2::Oid>, to: git2::Oid) -> Vec<String> {
    let tree = |oid: git2::Oid| repo.find_commit(oid).and_then(|c| c.tree()).ok();
    let Some(new) = tree(to) else { return Vec::new() };
    let old = from.and_then(tree);
    let Ok(diff) = repo.diff_tree_to_tree(old.as_ref(), Some(&new), None) else { return Vec::new() };
    let mut out: Vec<String> = diff
        .deltas()
        .filter_map(|d| d.new_file().path().or_else(|| d.old_file().path()).map(|p| p.to_string_lossy().into_owned()))
        .collect();
    out.sort();
    out.dedup();
    out
}

fn count_commits(repo: &Repository, from: git2::Oid) -> usize {
    let Ok(mut walk) = repo.revwalk() else { return 0 };
    if walk.push(from).is_err() {
        return 0;
    }
    walk.take(10_000).count()
}

pub fn log(repo: &Repository, limit: usize) -> Result<Vec<CommitInfo>, String> {
    let mut walk = repo.revwalk().map_err(err)?;
    if walk.push_head().is_err() {
        return Ok(Vec::new());
    }
    walk.set_sorting(Sort::TIME).map_err(err)?;
    Ok(walk
        .take(limit)
        .filter_map(|oid| oid.ok().and_then(|oid| repo.find_commit(oid).ok()))
        .map(|c| commit_info(&c))
        .collect())
}

/// A unified diff of one path against HEAD, for the commit sheet.
pub fn diff(repo: &Repository, path: &str) -> Result<String, String> {
    let mut options = DiffOptions::new();
    options.pathspec(path).include_untracked(true).show_untracked_content(true).recurse_untracked_dirs(true).context_lines(2);
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let diff = repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut options)).map_err(err)?;
    let mut out = String::new();
    diff.print(DiffFormat::Patch, |_delta, _hunk, line| {
        if out.len() > 200_000 {
            return false;
        }
        let origin = line.origin();
        if matches!(origin, '+' | '-' | ' ') {
            out.push(origin);
        }
        out.push_str(&String::from_utf8_lossy(line.content()));
        true
    })
    .or_else(|e| if out.len() > 200_000 { Ok(()) } else { Err(e) })
    .map_err(err)?;
    Ok(out)
}

/// One file as it is in a commit (`HEAD`, `origin/main`, an id): `None` when
/// that commit does not have it. For the word-level change views, which
/// compare it with the file on disk.
pub fn show(repo: &Repository, rev: &str, path: &str) -> Result<Option<String>, String> {
    let rel = crate::store::safe_relative(path)?;
    let Ok(object) = repo.revparse_single(rev) else { return Ok(None) };
    let tree = object.peel_to_tree().map_err(err)?;
    let Ok(entry) = tree.get_path(&rel) else { return Ok(None) };
    let blob = entry.to_object(repo).and_then(|o| o.peel_to_blob()).map_err(err)?;
    if blob.is_binary() {
        return Err(format!("{path} is not text"));
    }
    if blob.size() > 4 * 1024 * 1024 {
        return Err(format!("{path} is too large to compare"));
    }
    Ok(Some(String::from_utf8_lossy(blob.content()).into_owned()))
}

// ── network: fetch, pull, push ──────────────────────────────────────────────

/// Fetch one branch (or, with `None`, every branch) into `origin/*`.
///
/// Never touches the working tree or any local branch — this is the "is there
/// anything new?" call, safe to make whenever a repository is opened.
pub fn fetch(repo: &Repository, branch: Option<&str>, token: Option<&str>) -> Result<(), String> {
    let mut remote = repo.find_remote("origin").map_err(err)?;
    let tracking = branch.map(|b| format!("refs/remotes/origin/{b}"));
    let before = tracking.as_deref().and_then(|r| repo.refname_to_id(r).ok());
    events::debug("git", match branch {
        Some(b) => format!("Fetching {b} from GitHub"),
        None => "Fetching every branch from GitHub".to_string(),
    });
    let asked = Cell::new(0);
    let task = events::task("git", "Fetching", "objects");
    let mut cbs = callbacks(token, &asked);
    cbs.transfer_progress(|stats| {
        if stats.total_objects() > 0 {
            task.update(stats.received_objects() as u64, stats.total_objects() as u64);
        }
        true
    });
    let mut options = FetchOptions::new();
    options.remote_callbacks(cbs);
    options.proxy_options(proxy());
    options.download_tags(AutotagOption::None);
    let refspec = match branch {
        Some(b) => format!("+refs/heads/{b}:refs/remotes/origin/{b}"),
        None => {
            options.prune(git2::FetchPrune::On);
            "+refs/heads/*:refs/remotes/origin/*".to_string()
        }
    };
    match remote.fetch(&[refspec.as_str()], Some(&mut options), None) {
        Ok(()) => {
            let after = tracking.as_deref().and_then(|r| repo.refname_to_id(r).ok());
            match (branch, before, after) {
                (Some(b), Some(old), Some(new)) if old != new => {
                    let n = repo.graph_ahead_behind(new, old).map(|(a, _)| a).unwrap_or(0);
                    events::info("git", format!("{n} new commit{} on GitHub's {b}", if n == 1 { "" } else { "s" }));
                }
                (Some(b), None, Some(_)) => events::info("git", format!("Fetched {b} from GitHub")),
                (Some(b), _, _) => events::debug("git", format!("Nothing new on GitHub's {b}")),
                (None, _, _) => events::debug("git", "Fetched every branch"),
            }
            Ok(())
        }
        // A branch made here and not pushed yet has nothing to fetch.
        Err(e) if branch.is_some() && e.message().contains("couldn't find remote ref") => Ok(()),
        Err(e) => Err(network_failure(&e, token)),
    }
}

/// Fetch, then bring the current branch up to date with `origin/<branch>`.
pub fn pull(repo: &Repository, token: Option<&str>, who: &Signature) -> Result<PullOutcome, String> {
    let branch = current_branch(repo);
    fetch(repo, Some(&branch), token)?;
    let outcome = merge_upstream(repo, &branch, who)?;
    events::info("git", match &outcome {
        PullOutcome::UpToDate => format!("{branch} is already up to date"),
        PullOutcome::NoUpstream => format!("{branch} is not on GitHub yet; nothing to pull"),
        PullOutcome::FastForward { commits } => format!("Fast-forwarded {branch} by {commits} commit{}", if *commits == 1 { "" } else { "s" }),
        PullOutcome::Merged { commits } => format!("Merged {commits} commit{} from GitHub into {branch}", if *commits == 1 { "" } else { "s" }),
    });
    Ok(outcome)
}

/// The local half of a pull: integrate `origin/<branch>` into `<branch>`.
///
/// Split out so tests can drive it against a fetched-but-unmerged state.
pub fn merge_upstream(repo: &Repository, branch: &str, who: &Signature) -> Result<PullOutcome, String> {
    let Ok(remote_ref) = repo.find_reference(&format!("refs/remotes/origin/{branch}")) else {
        return Ok(PullOutcome::NoUpstream);
    };
    let incoming = repo.reference_to_annotated_commit(&remote_ref).map_err(err)?;
    let (analysis, _) = repo.merge_analysis(&[&incoming]).map_err(err)?;

    if analysis.is_up_to_date() {
        return Ok(PullOutcome::UpToDate);
    }

    let local_head = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let local_id = local_head.as_ref().map(|c| c.id());
    let count_new = |from: git2::Oid| -> usize {
        match local_id {
            Some(local) => repo.graph_ahead_behind(from, local).map(|(a, _)| a).unwrap_or(0),
            None => count_commits(repo, from),
        }
    };

    if analysis.is_fast_forward() || analysis.is_unborn() {
        let target = incoming.id();
        let commits = count_new(target);
        let object = repo.find_object(target, None).map_err(err)?;
        // `safe`: a file edited here that the incoming commits also change is
        // a conflict, and libgit2 refuses rather than overwriting the edit.
        repo.checkout_tree(&object, Some(CheckoutBuilder::new().safe()))
            .map_err(|e| local_edits_conflict(repo, &e))?;
        let refname = format!("refs/heads/{branch}");
        match repo.find_reference(&refname) {
            Ok(mut r) => {
                r.set_target(target, "gitidor: fast-forward").map_err(err)?;
            }
            Err(_) => {
                repo.reference(&refname, target, true, "gitidor: fast-forward").map_err(err)?;
            }
        }
        repo.set_head(&refname).map_err(err)?;
        return Ok(PullOutcome::FastForward { commits });
    }

    // Both sides moved. Merge in memory first, so a conflicted merge never
    // touches the working tree or the index.
    let local = local_head.ok_or("The local branch has no commits to merge into")?;
    let theirs = repo.find_commit(incoming.id()).map_err(err)?;
    let mut merged = repo.merge_commits(&local, &theirs, None).map_err(err)?;
    if merged.has_conflicts() {
        let files: Vec<String> = merged
            .conflicts()
            .map_err(err)?
            .filter_map(|c| c.ok())
            .filter_map(|c| c.our.or(c.their).map(|e| String::from_utf8_lossy(&e.path).to_string()))
            .collect();
        return Err(format!(
            "Your commits and the ones on GitHub both changed {}. Nothing was changed here. \
             Resolve it on GitHub or in another git client, then pull again.",
            files.join(", ")
        ));
    }
    let commits = count_new(theirs.id());
    let tree_id = merged.write_tree_to(repo).map_err(err)?;
    let tree = repo.find_tree(tree_id).map_err(err)?;
    repo.checkout_tree(tree.as_object(), Some(CheckoutBuilder::new().safe()))
        .map_err(|e| local_edits_conflict(repo, &e))?;
    let message = format!("Merge origin/{branch} into {branch}");
    repo.commit(Some("HEAD"), who, who, &message, &tree, &[&local, &theirs]).map_err(err)?;
    // `checkout_tree` updated the index to the merged tree already.
    Ok(PullOutcome::Merged { commits })
}

fn local_edits_conflict(repo: &Repository, e: &git2::Error) -> String {
    let edited: Vec<String> = changes(repo).unwrap_or_default().into_iter().map(|c| c.path).collect();
    if edited.is_empty() {
        return msg(e);
    }
    format!(
        "Incoming changes touch files you have edited ({}). Commit your edits first, then pull again — \
         nothing was overwritten.",
        edited.join(", ")
    )
}

/// Push the current branch to `origin`. Creates it there if it is new.
pub fn push(repo: &Repository, token: Option<&str>) -> Result<(), String> {
    let branch = current_branch(repo);
    let mut remote = repo.find_remote("origin").map_err(err)?;
    let rejected: RefCell<Option<String>> = RefCell::new(None);
    let asked = Cell::new(0);
    let before = repo.refname_to_id(&format!("refs/remotes/origin/{branch}")).ok();
    events::info("git", format!("Pushing {branch} to GitHub"));
    let task = events::task("git", "Sending objects", "objects");
    {
        let mut cbs = callbacks(token, &asked);
        cbs.push_transfer_progress(|current, total, _bytes| {
            if total > 0 {
                task.update(current as u64, total as u64);
            }
        });
        // A refused ref is *not* an error from `push` — libgit2 reports it
        // here, per reference, and `push` itself returns Ok.
        cbs.push_update_reference(|name, status| {
            match status {
                Some(message) => {
                    events::warn("git", format!("GitHub refused {name}: {message}"));
                    *rejected.borrow_mut() = Some(message.to_string());
                }
                None => events::debug("git", format!("GitHub accepted {name}")),
            }
            Ok(())
        });
        let mut options = PushOptions::new();
        options.remote_callbacks(cbs);
        options.proxy_options(proxy());
        let spec = format!("refs/heads/{branch}:refs/heads/{branch}");
        remote.push(&[spec.as_str()], Some(&mut options)).map_err(|e| {
            let message = msg(&e);
            if message.contains("non-fast-forward") || message.contains("fetch first") || message.contains("not present locally") {
                behind_message(&branch)
            } else {
                network_failure(&e, token)
            }
        })?;
    }
    if let Some(message) = rejected.into_inner() {
        return Err(if message.contains("fast-forward") || message.contains("fetch first") {
            behind_message(&branch)
        } else {
            format!("GitHub refused the push to {branch}: {message}")
        });
    }
    // Keep `origin/<branch>` where GitHub now has it, so ahead/behind is right
    // without another fetch.
    let head = repo.refname_to_id(&format!("refs/heads/{branch}")).map_err(err)?;
    repo.reference(&format!("refs/remotes/origin/{branch}"), head, true, "gitidor: push").map_err(err)?;
    task.finish(0, 0);
    let short = |oid: git2::Oid| oid.to_string()[..7].to_string();
    events::info("git", match before {
        Some(old) if old != head => format!("Pushed {}..{} to {branch}", short(old), short(head)),
        Some(_) => format!("{branch} was already on GitHub"),
        None => format!("Pushed {branch} to GitHub as a new branch ({})", short(head)),
    });
    Ok(())
}

fn behind_message(branch: &str) -> String {
    format!("{branch} has new commits on GitHub. Pull first, then push — nothing was lost.")
}

// ── commit ──────────────────────────────────────────────────────────────────

/// Commit exactly these paths, as they are on disk now. A path that no longer
/// exists is committed as a deletion.
pub fn commit(repo: &Repository, paths: &[String], message: &str, who: &Signature) -> Result<CommitInfo, String> {
    if paths.is_empty() {
        return Err("Choose at least one file to commit".into());
    }
    if message.trim().is_empty() {
        return Err("Write a commit message".into());
    }
    let workdir = repo.workdir().ok_or("This repository has no working tree")?.to_path_buf();
    let mut index = repo.index().map_err(err)?;
    for rel in paths {
        let rel_path = crate::store::safe_relative(rel)?;
        if workdir.join(&rel_path).exists() {
            index.add_path(&rel_path).map_err(err)?;
        } else {
            index.remove_path(&rel_path).map_err(err)?;
        }
    }
    index.write().map_err(err)?;
    let tree_id = index.write_tree().map_err(err)?;
    let tree = repo.find_tree(tree_id).map_err(err)?;
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    if parent.as_ref().map(|p| p.tree_id()) == Some(tree_id) {
        return Err("Those files have no changes to commit".into());
    }
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let oid = repo.commit(Some("HEAD"), who, who, message.trim(), &tree, &parents).map_err(err)?;
    let commit = repo.find_commit(oid).map_err(err)?;
    let info = commit_info(&commit);
    events::info("git", format!("Committed {} “{}” ({} file{})", info.short, info.summary, paths.len(), if paths.len() == 1 { "" } else { "s" }));
    Ok(info)
}

/// Stage everything — used only by tests to build fixtures.
#[cfg(test)]
pub fn commit_all(repo: &Repository, message: &str, who: &Signature) -> Result<CommitInfo, String> {
    let mut index = repo.index().map_err(err)?;
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None).map_err(err)?;
    index.write().map_err(err)?;
    let paths: Vec<String> = changes(repo)?.into_iter().map(|c| c.path).collect();
    commit(repo, &paths, message, who)
}

/// Put one file back the way HEAD has it. A file HEAD does not have is deleted.
pub fn discard(repo: &Repository, path: &str) -> Result<(), String> {
    let rel = crate::store::safe_relative(path)?;
    let workdir = repo.workdir().ok_or("This repository has no working tree")?.to_path_buf();
    let in_head = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_tree().ok())
        .map(|tree| tree.get_path(&rel).is_ok())
        .unwrap_or(false);
    if in_head {
        let mut checkout = CheckoutBuilder::new();
        checkout.force().path(&rel);
        repo.checkout_head(Some(&mut checkout)).map_err(err)?;
    } else {
        let full = workdir.join(&rel);
        if full.exists() {
            std::fs::remove_file(&full).map_err(|e| e.to_string())?;
        }
        let mut index = repo.index().map_err(err)?;
        let _ = index.remove_path(&rel);
        index.write().map_err(err)?;
    }
    events::info("git", if in_head { format!("Restored {path} from the last commit") } else { format!("Deleted {path}, which was new") });
    Ok(())
}

// ── rollback ────────────────────────────────────────────────────────────────

/// What rolling back would do, for the sheet that asks first.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackPlan {
    /// `local` (the last commit here) or `remote` (GitHub's branch, as last fetched).
    pub to: String,
    /// The commit the branch and every file go back to.
    pub target: CommitInfo,
    /// HEAD when the plan was made; the rollback refuses if it has moved.
    pub head: String,
    /// What the lost files are shown against: HEAD for a local rollback, the
    /// commit this branch and GitHub's last shared for a remote one, so that
    /// commits GitHub has and this copy does not are not counted as losses.
    pub base: String,
    /// Commits that would be lost, newest first.
    pub commits: Vec<CommitInfo>,
    /// Files whose changes would be lost, committed or not.
    pub files: Vec<Change>,
}

fn rollback_target<'r>(repo: &'r Repository, to: &str) -> Result<git2::Commit<'r>, String> {
    match to {
        "local" => repo.head().and_then(|h| h.peel_to_commit()).map_err(|_| "There is no commit to go back to yet".to_string()),
        "remote" => {
            let branch = current_branch(repo);
            repo.find_reference(&format!("refs/remotes/origin/{branch}"))
                .and_then(|r| r.peel_to_commit())
                .map_err(|_| format!("{branch} is not on GitHub yet, so there is no remote commit to go back to"))
        }
        other => Err(format!("Unknown rollback target {other}")),
    }
}

pub fn rollback_plan(repo: &Repository, to: &str) -> Result<RollbackPlan, String> {
    let target = rollback_target(repo, to)?;
    let head = repo.head().and_then(|h| h.peel_to_commit()).map_err(err)?;
    let base = if to == "local" { head.id() } else { repo.merge_base(head.id(), target.id()).map_err(err)? };

    let mut commits = Vec::new();
    if head.id() != target.id() {
        let mut walk = repo.revwalk().map_err(err)?;
        walk.push(head.id()).map_err(err)?;
        walk.hide(target.id()).map_err(err)?;
        walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME).map_err(err)?;
        for oid in walk.take(500) {
            if let Ok(c) = oid.and_then(|o| repo.find_commit(o)) {
                commits.push(commit_info(&c));
            }
        }
    }

    let base_tree = repo.find_commit(base).and_then(|c| c.tree()).map_err(err)?;
    let mut options = DiffOptions::new();
    options.include_untracked(true).recurse_untracked_dirs(true).include_ignored(false);
    let diff = repo.diff_tree_to_workdir_with_index(Some(&base_tree), Some(&mut options)).map_err(err)?;
    let mut files = Vec::new();
    for delta in diff.deltas() {
        let kind = match delta.status() {
            Delta::Added | Delta::Untracked | Delta::Copied => "added",
            Delta::Deleted => "deleted",
            Delta::Renamed => "renamed",
            Delta::Conflicted => "conflicted",
            Delta::Modified | Delta::Typechange => "modified",
            _ => continue,
        };
        let path = delta.new_file().path().or_else(|| delta.old_file().path());
        if let Some(path) = path {
            files.push(Change { path: path.to_string_lossy().into_owned(), kind: kind.into() });
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(RollbackPlan { to: to.into(), target: commit_info(&target), head: head.id().to_string(), base: base.to_string(), commits, files })
}

/// Put the branch and the working tree back at the plan's target: committed
/// and uncommitted changes go, and so do new files git is not ignoring. It
/// refuses when HEAD or the target has moved since the plan was shown.
pub fn rollback(repo: &Repository, to: &str, expect_head: &str, expect_target: &str) -> Result<CommitInfo, String> {
    let target = rollback_target(repo, to)?;
    let head = repo.head().and_then(|h| h.peel_to_commit()).map_err(err)?;
    if head.id().to_string() != expect_head || target.id().to_string() != expect_target {
        return Err("Something changed since the list was made. Look at it again before rolling back.".into());
    }
    // Reset alone keeps untracked files, and libgit2's hard reset replaces
    // whatever checkout strategy it is given; so check out first, removing
    // untracked files, then move the branch.
    let mut checkout = CheckoutBuilder::new();
    checkout.force().remove_untracked(true);
    repo.checkout_tree(target.as_object(), Some(&mut checkout)).map_err(err)?;
    repo.reset(target.as_object(), ResetType::Hard, None).map_err(err)?;
    let info = commit_info(&target);
    events::info(
        "git",
        format!("Rolled {} back to {} “{}”{}", current_branch(repo), info.short, info.summary, if to == "remote" { ", GitHub's last known commit" } else { "" }),
    );
    Ok(info)
}

// ── branches ────────────────────────────────────────────────────────────────

pub fn branches(repo: &Repository) -> Result<Branches, String> {
    let current = current_branch(repo);
    let mut local = Vec::new();
    for b in repo.branches(Some(BranchType::Local)).map_err(err)? {
        let (branch, _) = b.map_err(err)?;
        if let Ok(Some(name)) = branch.name() {
            local.push(name.to_string());
        }
    }
    if !local.contains(&current) {
        local.push(current.clone());
    }
    let mut remote_only = Vec::new();
    for b in repo.branches(Some(BranchType::Remote)).map_err(err)? {
        let (branch, _) = b.map_err(err)?;
        if let Ok(Some(name)) = branch.name() {
            if let Some(short) = name.strip_prefix("origin/") {
                if short != "HEAD" && !local.iter().any(|l| l == short) {
                    remote_only.push(short.to_string());
                }
            }
        }
    }
    local.sort();
    remote_only.sort();
    Ok(Branches { current, local, remote_only })
}

/// Switch to `name`: a local branch, a branch that is only on origin (made
/// locally from it), or — with `create` — a new branch from HEAD.
///
/// Edits that the switch does not touch come along, as with `git switch`; an
/// edit to a file the other branch has differently stops the switch.
pub fn checkout(repo: &Repository, name: &str, create: bool) -> Result<(), String> {
    let name = crate::remote::checked_branch(name)?;
    let refname = format!("refs/heads/{name}");

    if create {
        if repo.find_reference(&refname).is_ok() {
            return Err(format!("{name} already exists"));
        }
        let head = repo.head().map_err(err)?.peel_to_commit().map_err(err)?;
        repo.branch(&name, &head, false).map_err(err)?;
        repo.set_head(&refname).map_err(err)?;
        events::info("git", format!("Created branch {name} from {}", current_branch(repo)));
        return Ok(());
    }

    let from_github = repo.find_reference(&refname).is_err();
    let target = match repo.find_reference(&refname) {
        Ok(r) => r.peel_to_commit().map_err(err)?,
        Err(_) => {
            let remote = repo
                .find_reference(&format!("refs/remotes/origin/{name}"))
                .map_err(|_| format!("There is no branch called {name}"))?
                .peel_to_commit()
                .map_err(err)?;
            let mut branch = repo.branch(&name, &remote, false).map_err(err)?;
            branch.set_upstream(Some(&format!("origin/{name}"))).map_err(err)?;
            remote
        }
    };
    repo.checkout_tree(target.as_object(), Some(CheckoutBuilder::new().safe()))
        .map_err(|e| local_edits_conflict(repo, &e))?;
    repo.set_head(&refname).map_err(err)?;
    events::info("git", if from_github { format!("Switched to {name}, made from GitHub's {name}") } else { format!("Switched to {name}") });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn who() -> Signature<'static> {
        Signature::now("Test", "test@example.com").unwrap()
    }

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gitidor-git-{}-{name}-{}", std::process::id(), crate::store::new_id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A bare "GitHub" with one commit on main, and the URL to reach it.
    fn origin() -> (PathBuf, String) {
        let bare = tmp("origin.git");
        Repository::init_bare(&bare).unwrap();
        let seed_dir = tmp("seed");
        let seed = Repository::init(&seed_dir).unwrap();
        seed.set_head("refs/heads/main").unwrap();
        fs::create_dir_all(seed_dir.join("posts")).unwrap();
        fs::write(seed_dir.join("posts/hello.md"), "---\ntitle: Hello\n---\nHi\n").unwrap();
        commit_all(&seed, "First post", &who()).unwrap();
        seed.remote("origin", bare.to_str().unwrap()).unwrap();
        push(&seed, None).unwrap();
        let url = bare.to_str().unwrap().to_string();
        (bare, url)
    }

    fn clone_of(url: &str, name: &str) -> Repository {
        let dir = tmp(name);
        fs::remove_dir_all(&dir).unwrap();
        clone(url, Some("main"), &dir, None, &|_| {}).unwrap();
        open(&dir).unwrap()
    }

    fn write(repo: &Repository, rel: &str, text: &str) {
        let path = repo.workdir().unwrap().join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn an_edit_is_committed_pushed_and_seen_by_another_clone() {
        let (_bare, url) = origin();
        let a = clone_of(&url, "a");
        assert_eq!(current_branch(&a), "main");
        assert!(status(&a).unwrap().changes.is_empty());

        write(&a, "posts/hello.md", "---\ntitle: Hello\n---\nHi again\n");
        write(&a, "posts/new.md", "# New\n");
        let st = status(&a).unwrap();
        assert_eq!(
            st.changes,
            vec![
                Change { path: "posts/hello.md".into(), kind: "modified".into() },
                Change { path: "posts/new.md".into(), kind: "added".into() },
            ]
        );

        // Only the chosen file is committed; the other stays a change.
        commit(&a, &["posts/hello.md".into()], "Edit hello", &who()).unwrap();
        let st = status(&a).unwrap();
        assert_eq!(st.ahead, 1);
        assert_eq!(st.changes.len(), 1);

        push(&a, None).unwrap();
        assert_eq!(status(&a).unwrap().ahead, 0);

        let b = clone_of(&url, "b");
        let text = fs::read_to_string(b.workdir().unwrap().join("posts/hello.md")).unwrap();
        assert!(text.contains("Hi again"));
        assert!(!b.workdir().unwrap().join("posts/new.md").exists());
    }

    #[test]
    fn pull_fast_forwards_and_reports_how_far() {
        let (_bare, url) = origin();
        let a = clone_of(&url, "ff-a");
        let b = clone_of(&url, "ff-b");
        write(&a, "posts/one.md", "1");
        commit_all(&a, "one", &who()).unwrap();
        write(&a, "posts/two.md", "2");
        commit_all(&a, "two", &who()).unwrap();
        push(&a, None).unwrap();

        fetch(&b, Some("main"), None).unwrap();
        assert_eq!(status(&b).unwrap().behind, 2);
        assert_eq!(pull(&b, None, &who()).unwrap(), PullOutcome::FastForward { commits: 2 });
        assert!(b.workdir().unwrap().join("posts/two.md").exists());
        assert_eq!(pull(&b, None, &who()).unwrap(), PullOutcome::UpToDate);
    }

    #[test]
    fn a_push_behind_github_is_refused_and_a_clean_merge_fixes_it() {
        let (_bare, url) = origin();
        let a = clone_of(&url, "m-a");
        let b = clone_of(&url, "m-b");
        write(&a, "posts/from-a.md", "a");
        commit_all(&a, "from a", &who()).unwrap();
        push(&a, None).unwrap();

        write(&b, "posts/from-b.md", "b");
        commit_all(&b, "from b", &who()).unwrap();
        let refused = push(&b, None).unwrap_err();
        assert!(refused.contains("Pull first"), "{refused}");

        assert_eq!(pull(&b, None, &who()).unwrap(), PullOutcome::Merged { commits: 1 });
        assert!(b.workdir().unwrap().join("posts/from-a.md").exists());
        push(&b, None).unwrap();
        let st = status(&b).unwrap();
        assert_eq!((st.ahead, st.behind), (0, 0));
    }

    #[test]
    fn a_conflicting_merge_changes_nothing() {
        let (_bare, url) = origin();
        let a = clone_of(&url, "c-a");
        let b = clone_of(&url, "c-b");
        write(&a, "posts/hello.md", "from a\n");
        commit_all(&a, "a", &who()).unwrap();
        push(&a, None).unwrap();

        write(&b, "posts/hello.md", "from b\n");
        commit_all(&b, "b", &who()).unwrap();
        let before = b.head().unwrap().target().unwrap();
        let message = pull(&b, None, &who()).unwrap_err();
        assert!(message.contains("posts/hello.md"), "{message}");
        assert_eq!(b.head().unwrap().target().unwrap(), before);
        let text = fs::read_to_string(b.workdir().unwrap().join("posts/hello.md")).unwrap();
        assert_eq!(text, "from b\n");
    }

    #[test]
    fn an_uncommitted_edit_is_never_overwritten_by_a_pull() {
        let (_bare, url) = origin();
        let a = clone_of(&url, "u-a");
        let b = clone_of(&url, "u-b");
        write(&a, "posts/hello.md", "upstream\n");
        commit_all(&a, "a", &who()).unwrap();
        push(&a, None).unwrap();

        write(&b, "posts/hello.md", "my unsaved work\n");
        let message = pull(&b, None, &who()).unwrap_err();
        assert!(message.contains("Commit your edits first"), "{message}");
        let text = fs::read_to_string(b.workdir().unwrap().join("posts/hello.md")).unwrap();
        assert_eq!(text, "my unsaved work\n");
    }

    #[test]
    fn deletions_commit_and_discard_restores() {
        let (_bare, url) = origin();
        let a = clone_of(&url, "d-a");
        write(&a, "posts/hello.md", "changed");
        discard(&a, "posts/hello.md").unwrap();
        assert!(status(&a).unwrap().changes.is_empty());

        write(&a, "posts/scratch.md", "x");
        discard(&a, "posts/scratch.md").unwrap();
        assert!(!a.workdir().unwrap().join("posts/scratch.md").exists());

        fs::remove_file(a.workdir().unwrap().join("posts/hello.md")).unwrap();
        assert_eq!(status(&a).unwrap().changes[0].kind, "deleted");
        commit(&a, &["posts/hello.md".into()], "Remove hello", &who()).unwrap();
        assert!(status(&a).unwrap().changes.is_empty());
    }

    #[test]
    fn branches_are_created_switched_and_pushed() {
        let (_bare, url) = origin();
        let a = clone_of(&url, "br-a");
        checkout(&a, "drafts", true).unwrap();
        assert_eq!(current_branch(&a), "drafts");
        assert!(!status(&a).unwrap().has_upstream);
        write(&a, "posts/draft.md", "d");
        commit_all(&a, "draft", &who()).unwrap();
        push(&a, None).unwrap();
        assert!(status(&a).unwrap().has_upstream);

        let b = clone_of(&url, "br-b");
        fetch(&b, None, None).unwrap();
        let listed = branches(&b).unwrap();
        assert_eq!(listed.remote_only, vec!["drafts".to_string()]);
        checkout(&b, "drafts", false).unwrap();
        assert!(b.workdir().unwrap().join("posts/draft.md").exists());
        checkout(&b, "main", false).unwrap();
        assert!(!b.workdir().unwrap().join("posts/draft.md").exists());
    }

    /// Over the network, against a real public repository. Not run by default:
    /// `cargo test -- --ignored` with network access.
    #[test]
    #[ignore]
    fn a_public_repository_clones_over_https() {
        let dir = tmp("https");
        fs::remove_dir_all(&dir).unwrap();
        let branch = clone("https://github.com/laffan/hush.git", None, &dir, None, &|_| {}).unwrap();
        let repo = open(&dir).unwrap();
        assert_eq!(current_branch(&repo), branch);
        fetch(&repo, Some(&branch), None).unwrap();
        assert_eq!(status(&repo).unwrap().behind, 0);
    }

    #[test]
    fn show_reads_a_file_at_a_commit() {
        let (_bare, url) = origin();
        let a = clone_of(&url, "show");
        write(&a, "posts/hello.md", "changed\n");
        assert_eq!(show(&a, "HEAD", "posts/hello.md").unwrap().as_deref(), Some("---\ntitle: Hello\n---\nHi\n"));
        assert_eq!(show(&a, "origin/main", "posts/hello.md").unwrap().as_deref(), Some("---\ntitle: Hello\n---\nHi\n"));
        assert_eq!(show(&a, "HEAD", "posts/missing.md").unwrap(), None);
        assert_eq!(show(&a, "no-such-rev", "posts/hello.md").unwrap(), None);
        assert!(show(&a, "HEAD", "../outside").is_err());
    }

    #[test]
    fn status_lists_the_files_unpushed_commits_change() {
        let (_bare, url) = origin();
        let a = clone_of(&url, "unpushed");
        write(&a, "posts/one.md", "1");
        commit_all(&a, "one", &who()).unwrap();
        write(&a, "posts/hello.md", "edited");
        let st = status(&a).unwrap();
        assert_eq!(st.unpushed, vec!["posts/one.md".to_string()]);
        push(&a, None).unwrap();
        assert!(status(&a).unwrap().unpushed.is_empty());
    }

    #[test]
    fn rollback_to_the_last_local_commit_drops_every_uncommitted_change() {
        let (_bare, url) = origin();
        let a = clone_of(&url, "rb-local");
        let root = a.workdir().unwrap().to_path_buf();
        fs::write(root.join(".gitignore"), "cache/\n").unwrap();
        commit_all(&a, "ignore cache", &who()).unwrap();
        write(&a, "posts/hello.md", "edited\n");
        write(&a, "posts/new.md", "new\n");
        write(&a, "cache/keep.txt", "ignored\n");

        let plan = rollback_plan(&a, "local").unwrap();
        assert!(plan.commits.is_empty());
        assert_eq!(
            plan.files,
            vec![
                Change { path: "posts/hello.md".into(), kind: "modified".into() },
                Change { path: "posts/new.md".into(), kind: "added".into() },
            ]
        );
        rollback(&a, "local", &plan.head, &plan.target.id).unwrap();
        assert!(status(&a).unwrap().changes.is_empty());
        assert_eq!(fs::read_to_string(root.join("posts/hello.md")).unwrap(), "---\ntitle: Hello\n---\nHi\n");
        assert!(!root.join("posts/new.md").exists());
        assert!(root.join("cache/keep.txt").exists(), "an ignored file was removed");
    }

    #[test]
    fn rollback_to_the_remote_drops_unpushed_commits_and_refuses_a_stale_plan() {
        let (_bare, url) = origin();
        let a = clone_of(&url, "rb-remote");
        let root = a.workdir().unwrap().to_path_buf();
        write(&a, "posts/one.md", "1");
        commit_all(&a, "one", &who()).unwrap();
        write(&a, "posts/hello.md", "edited\n");

        let plan = rollback_plan(&a, "remote").unwrap();
        assert_eq!(plan.commits.len(), 1);
        assert_eq!(plan.commits[0].summary, "one");
        assert_eq!(plan.files.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(), vec!["posts/hello.md", "posts/one.md"]);
        assert_eq!(show(&a, &plan.base, "posts/one.md").unwrap(), None);

        // Something moved after the plan was shown: nothing is touched.
        write(&a, "posts/two.md", "2");
        commit_all(&a, "two", &who()).unwrap();
        assert!(rollback(&a, "remote", &plan.head, &plan.target.id).is_err());
        assert!(root.join("posts/two.md").exists());

        let plan = rollback_plan(&a, "remote").unwrap();
        assert_eq!(plan.commits.len(), 2);
        rollback(&a, "remote", &plan.head, &plan.target.id).unwrap();
        let st = status(&a).unwrap();
        assert_eq!((st.ahead, st.behind, st.changes.len()), (0, 0, 0));
        assert!(!root.join("posts/one.md").exists());
        assert!(rollback_plan(&a, "nowhere").is_err());
    }

    #[test]
    fn a_diff_shows_the_edit() {
        let (_bare, url) = origin();
        let a = clone_of(&url, "diff");
        write(&a, "posts/hello.md", "---\ntitle: Hello\n---\nHi there\n");
        let d = diff(&a, "posts/hello.md").unwrap();
        assert!(d.contains("-Hi"), "{d}");
        assert!(d.contains("+Hi there"), "{d}");
        assert_eq!(log(&a, 5).unwrap()[0].summary, "First post");
    }
}
