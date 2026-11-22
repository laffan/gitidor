//! The questions about GitHub that git itself cannot answer.
//!
//! Adapted from idlewild-editor's `github_api.rs`: who a token belongs to,
//! which repositories it can see, which branches a repository has — plus the
//! one this app adds, where GitHub Pages serves a repository, so the Add Repo
//! sheet can fill in the public URL rather than asking for it.
//!
//! The token is optional throughout. A public repository answers all of these
//! anonymously, at GitHub's anonymous rate limit (60 requests an hour), which
//! is plenty for adding one.

use crate::http;
use serde::Serialize;

const API: &str = "https://api.github.com";
const VERSION: &str = "2022-11-28";
const MAX_PAGES: u32 = 20;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub owner: String,
    pub repo: String,
    pub full_name: String,
    pub description: String,
    pub private: bool,
    /// Whether this token may push. Anonymous callers are never told yes.
    pub can_push: bool,
    pub default_branch: String,
    pub branches: Vec<String>,
    /// From the Pages API when it answers, else the conventional address.
    pub pages_url: String,
    /// Whether `pages_url` came from GitHub rather than from convention.
    pub pages_confirmed: bool,
    pub signed_in: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    pub full_name: String,
    pub private: bool,
    pub can_push: bool,
    pub default_branch: String,
    pub description: String,
}

pub struct Reply {
    pub status: u16,
    pub body: serde_json::Value,
    pub text: String,
}

fn get(token: Option<&str>, url: &str) -> Result<Reply, String> {
    let mut request = http::api()
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", VERSION);
    if let Some(token) = token {
        request = request.header("Authorization", &format!("Bearer {token}"));
    }
    let started = std::time::Instant::now();
    let path = url.strip_prefix(API).unwrap_or(url);
    let mut response = request.call().map_err(|e| {
        let message = http::transport_error(&e, "GitHub");
        crate::events::warn("github", format!("GET {path} failed: {message}"));
        message
    })?;
    let status = response.status().as_u16();
    let text = response.body_mut().read_to_string().unwrap_or_default();
    crate::events::debug("github", format!("GET {path} → {status} ({} ms)", started.elapsed().as_millis()));
    if let Some(left) = response.headers().get("x-ratelimit-remaining").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u32>().ok()) {
        if left < 10 {
            crate::events::warn("github", format!("GitHub API: {left} requests left this hour"));
        }
    }
    let body = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    Ok(Reply { status, body, text })
}

/// A non-2xx answer, said in terms of what to do about it.
fn failure(reply: &Reply, signed_in: bool, what: &str) -> String {
    let detail = http::error_message(&reply.text);
    match reply.status {
        401 => "GitHub did not accept the saved token. It may have been revoked or expired — sign in again under Settings → GitHub.".into(),
        403 if detail.to_ascii_lowercase().contains("rate limit") => {
            if signed_in {
                "GitHub is rate limiting this token. Wait a few minutes.".into()
            } else {
                "GitHub's anonymous rate limit is used up. Sign in under Settings → GitHub to raise it.".into()
            }
        }
        403 => format!("The token is valid but not allowed to read {what}. A fine-grained token has to list the repository and grant Contents access."),
        404 if !signed_in => format!("{what} was not found. If it is private, sign in under Settings → GitHub first."),
        404 => format!("{what} was not found, or this token cannot see it."),
        code => format!("GitHub answered {code}: {detail}"),
    }
}

pub fn whoami(token: &str) -> Result<String, String> {
    let reply = get(Some(token), &format!("{API}/user"))?;
    if reply.status != 200 {
        return Err(failure(&reply, true, "your account"));
    }
    reply
        .body
        .get("login")
        .and_then(|l| l.as_str())
        .map(str::to_string)
        .ok_or_else(|| "GitHub did not say who that token belongs to".into())
}

pub fn repo_info(token: Option<&str>, owner: &str, repo: &str) -> Result<RepoInfo, String> {
    let full = format!("{owner}/{repo}");
    let signed_in = token.is_some();
    let reply = get(token, &format!("{API}/repos/{owner}/{repo}"))?;
    if reply.status != 200 {
        return Err(failure(&reply, signed_in, &full));
    }
    let body = &reply.body;
    let str_of = |key: &str| body.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let owner = body.pointer("/owner/login").and_then(|v| v.as_str()).unwrap_or(owner).to_string();
    let repo = str_of("name");
    let default_branch = body.get("default_branch").and_then(|b| b.as_str()).unwrap_or("main").to_string();
    let can_push = body.pointer("/permissions/push").and_then(|p| p.as_bool()).unwrap_or(false);
    let has_pages = body.get("has_pages").and_then(|p| p.as_bool()).unwrap_or(false);

    let address = crate::remote::Address { owner: owner.clone(), repo: repo.clone() };
    let branches = list_branches(token, &owner, &repo).unwrap_or_else(|_| vec![default_branch.clone()]);
    let (pages_url, pages_confirmed) = match has_pages
        .then(|| pages(token, &owner, &repo))
        .flatten()
        .or_else(|| cname(token, &owner, &repo, &default_branch, &branches))
    {
        Some(url) => (url, true),
        None => (address.default_pages_url(), false),
    };

    Ok(RepoInfo {
        full_name: str_of("full_name"),
        description: str_of("description"),
        private: body.get("private").and_then(|p| p.as_bool()).unwrap_or(false),
        can_push,
        branches,
        default_branch,
        pages_url,
        pages_confirmed,
        owner,
        repo,
        signed_in,
    })
}

/// The Pages site's address, custom domain included, when GitHub will say.
fn pages(token: Option<&str>, owner: &str, repo: &str) -> Option<String> {
    let reply = get(token, &format!("{API}/repos/{owner}/{repo}/pages")).ok()?;
    if reply.status != 200 {
        return None;
    }
    reply.body.get("html_url").and_then(|u| u.as_str()).map(str::to_string)
}

/// A custom domain from a `CNAME` file, which is how GitHub Pages is told
/// about one. The Pages API answers this directly but only to a token with
/// Pages access; the file is readable by anyone who can read the repository.
fn cname(token: Option<&str>, owner: &str, repo: &str, default_branch: &str, branches: &[String]) -> Option<String> {
    let mut probes: Vec<(&str, &str)> = Vec::new();
    if branches.iter().any(|b| b == "gh-pages") {
        probes.push(("gh-pages", "CNAME"));
    }
    probes.extend([(default_branch, "CNAME"), (default_branch, "public/CNAME"), (default_branch, "static/CNAME")]);
    for (git_ref, path) in probes {
        let mut request = http::api()
            .get(&format!("{API}/repos/{owner}/{repo}/contents/{path}?ref={git_ref}"))
            .header("Accept", "application/vnd.github.raw+json")
            .header("X-GitHub-Api-Version", VERSION);
        if let Some(token) = token {
            request = request.header("Authorization", &format!("Bearer {token}"));
        }
        let Ok(mut response) = request.call() else { continue };
        if response.status().as_u16() != 200 {
            continue;
        }
        let text = response.body_mut().read_to_string().unwrap_or_default();
        let domain = text.lines().next().unwrap_or_default().trim();
        if domain.contains('.') && !domain.contains(' ') && !domain.contains('/') {
            return Some(format!("https://{domain}/"));
        }
    }
    None
}

pub fn list_branches(token: Option<&str>, owner: &str, repo: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for page in 1..=MAX_PAGES {
        let reply = get(token, &format!("{API}/repos/{owner}/{repo}/branches?per_page=100&page={page}"))?;
        if reply.status == 409 {
            // An empty repository has no branches; that is not a failure.
            return Ok(out);
        }
        if reply.status != 200 {
            return Err(failure(&reply, token.is_some(), &format!("{owner}/{repo}")));
        }
        let batch = reply.body.as_array().cloned().unwrap_or_default();
        out.extend(batch.iter().filter_map(|b| Some(b.get("name")?.as_str()?.to_string())));
        if batch.len() < 100 {
            break;
        }
    }
    out.sort();
    Ok(out)
}

/// Every repository the token can see, most recently pushed first.
pub fn list_repos(token: &str) -> Result<Vec<RepoSummary>, String> {
    let mut out = Vec::new();
    for page in 1..=MAX_PAGES {
        let reply = get(Some(token), &format!("{API}/user/repos?per_page=100&sort=pushed&page={page}"))?;
        if reply.status != 200 {
            return Err(failure(&reply, true, "your repositories"));
        }
        let batch = reply.body.as_array().cloned().unwrap_or_default();
        out.extend(batch.iter().filter_map(|v| {
            Some(RepoSummary {
                full_name: v.get("full_name")?.as_str()?.to_string(),
                private: v.get("private").and_then(|p| p.as_bool()).unwrap_or(false),
                can_push: v.pointer("/permissions/push").and_then(|p| p.as_bool()).unwrap_or(true),
                default_branch: v.get("default_branch").and_then(|b| b.as_str()).unwrap_or("main").to_string(),
                description: v.get("description").and_then(|d| d.as_str()).unwrap_or_default().to_string(),
            })
        }));
        if batch.len() < 100 {
            break;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    /// Anonymous, against a real public repository: `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn a_public_repository_answers_anonymously() {
        let target = std::env::var("GITIDOR_GH").unwrap_or_else(|_| "laffan/hush".into());
        let (owner, repo) = target.split_once('/').unwrap();
        let info = super::repo_info(None, owner, repo).unwrap();
        assert!(info.branches.contains(&info.default_branch), "{:?}", info.branches);
        println!("{} default={} pages={} confirmed={}", info.full_name, info.default_branch, info.pages_url, info.pages_confirmed);
    }
}
