//! The GitHub token and the AI keys.
//!
//! **None of them ever crosses the IPC boundary.** The webview is told whether
//! each one exists and, for GitHub, whose it is; every call that needs one is
//! made from Rust. A secret handed to a webview is a secret in a webview's
//! memory, and nothing the interface does needs the value itself.
//!
//! They live in `secrets.json`, mode 0600, beside the clones. That is not the
//! system keychain, and the trade-off is the same one idlewild-editor states:
//! anything that can read this file can already read every repository the
//! token was used to clone. Moving to Keychain (macOS and iOS both have it)
//! is the obvious next step and is listed in `docs/known-gaps.md`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Secrets {
    pub github_token: String,
    pub github_login: String,
    pub anthropic_key: String,
    pub openai_key: String,
}

/// What the webview may know about the secrets: whether they exist.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStatus {
    pub github_login: String,
    pub has_github_token: bool,
    pub has_anthropic_key: bool,
    pub has_openai_key: bool,
}

const FILE: &str = "secrets.json";

pub fn load() -> Result<Secrets, String> {
    crate::store::read_json(FILE)
}

pub fn save(secrets: &Secrets) -> Result<(), String> {
    crate::store::write_json(FILE, secrets, true)
}

pub fn status() -> Result<SecretStatus, String> {
    let s = load()?;
    Ok(SecretStatus {
        github_login: s.github_login.clone(),
        has_github_token: !s.github_token.is_empty(),
        has_anthropic_key: !s.anthropic_key.is_empty(),
        has_openai_key: !s.openai_key.is_empty(),
    })
}

/// The token, if there is one. Public repositories clone and fetch without it.
pub fn github_token() -> Option<String> {
    load().ok().map(|s| s.github_token).filter(|t| !t.is_empty())
}

pub fn github_login() -> String {
    load().map(|s| s.github_login).unwrap_or_default()
}

/// Replace every occurrence of a secret in text that is about to be shown.
///
/// libgit2 quotes the remote in some of its messages, and an HTTP error can
/// echo a header. Nothing here should put a token in either, but a message
/// that reaches the screen is checked anyway.
pub fn redact(text: &str) -> String {
    let Ok(s) = load() else { return text.to_string() };
    let mut out = text.to_string();
    for secret in [&s.github_token, &s.anthropic_key, &s.openai_key] {
        if secret.len() >= 8 {
            out = out.replace(secret.as_str(), "••••");
        }
    }
    out
}
