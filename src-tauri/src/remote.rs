//! Turning whatever somebody pastes into the Add Repo box into an owner, a
//! name and an HTTPS URL.
//!
//! People paste the SSH form (`git@github.com:laffan/blog.git`) because that
//! is what GitHub's Code button shows them first. This app talks to GitHub over
//! HTTPS with a token — libgit2 is built without SSH, as in idlewild-editor,
//! which keeps libssh2 out of the iOS build — so every accepted form is
//! rewritten to `https://github.com/<owner>/<repo>.git`.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Address {
    pub owner: String,
    pub repo: String,
}

impl Address {
    pub fn clone_url(&self) -> String {
        format!("https://github.com/{}/{}.git", self.owner, self.repo)
    }

    /// Where GitHub Pages serves a repository with no custom domain.
    pub fn default_pages_url(&self) -> String {
        let owner = self.owner.to_ascii_lowercase();
        if self.repo.eq_ignore_ascii_case(&format!("{owner}.github.io")) {
            format!("https://{owner}.github.io/")
        } else {
            format!("https://{owner}.github.io/{}/", self.repo)
        }
    }
}

/// Accepts `owner/repo`, `https://github.com/owner/repo(.git)(/…)`,
/// `git@github.com:owner/repo(.git)`, `ssh://git@github.com/owner/repo.git`
/// and `github.com/owner/repo`.
pub fn parse(input: &str) -> Result<Address, String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err("Enter a repository address".into());
    }

    let rest = if let Some(rest) = raw.strip_prefix("git@github.com:") {
        rest
    } else if let Some(idx) = raw.find("github.com/") {
        &raw[idx + "github.com/".len()..]
    } else if raw.contains("://") || raw.contains('@') {
        return Err(format!(
            "{raw} is not a GitHub address. gitidor works with repositories on github.com."
        ));
    } else {
        raw
    };

    let mut parts = rest.trim_matches('/').split('/');
    let owner = parts.next().unwrap_or_default();
    let repo = parts.next().unwrap_or_default();
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
    let repo = repo.split(['?', '#']).next().unwrap_or_default();

    Ok(Address { owner: checked(owner, "owner")?, repo: checked(repo, "repository")? })
}

/// A name as GitHub itself allows one.
fn checked(raw: &str, what: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(format!("The address is missing the {what} name"));
    }
    let valid = name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !name.starts_with('-')
        && name != "."
        && name != "..";
    if valid {
        Ok(name.to_string())
    } else {
        Err(format!("{name} is not a valid GitHub {what} name"))
    }
}

/// A branch name, by the rules of git that matter here.
pub fn checked_branch(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    let illegal = [' ', '~', '^', ':', '?', '*', '[', '\\'];
    if name.is_empty()
        || name.starts_with('-')
        || name.starts_with('/')
        || name.ends_with('/')
        || name.ends_with(".lock")
        || name.contains("..")
        || name.contains("@{")
        || name.chars().any(|c| illegal.contains(&c) || c.is_control())
    {
        return Err(format!("{name} is not a branch name git will accept"));
    }
    Ok(name.to_string())
}

/// The scheme and host of a public URL, and the path the site lives under.
///
/// `https://laffan.github.io/notes/` is `("https://laffan.github.io", "/notes")`;
/// a custom domain at its root has an empty base path. The base path is what a
/// project-pages site puts in front of every link, so it is what the preview
/// strips before asking which file a page came from.
pub fn split_public_url(url: &str) -> Option<(String, String)> {
    let trimmed = url.trim();
    let (scheme, rest) = trimmed.split_once("://")?;
    if scheme != "https" && scheme != "http" {
        return None;
    }
    let (host, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if host.is_empty() {
        return None;
    }
    let path = path.split(['?', '#']).next().unwrap_or_default().trim_end_matches('/');
    Some((format!("{scheme}://{host}"), path.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addr(owner: &str, repo: &str) -> Address {
        Address { owner: owner.into(), repo: repo.into() }
    }

    #[test]
    fn every_way_github_shows_an_address_is_accepted() {
        let want = addr("laffan", "blog.natelaffan.com");
        for input in [
            "git@github.com:laffan/blog.natelaffan.com.git",
            "https://github.com/laffan/blog.natelaffan.com",
            "https://github.com/laffan/blog.natelaffan.com.git",
            "https://github.com/laffan/blog.natelaffan.com/tree/main/posts",
            "ssh://git@github.com/laffan/blog.natelaffan.com.git",
            "github.com/laffan/blog.natelaffan.com",
            "laffan/blog.natelaffan.com",
            "  laffan/blog.natelaffan.com  ",
        ] {
            assert_eq!(parse(input).unwrap(), want, "{input}");
        }
        assert_eq!(want.clone_url(), "https://github.com/laffan/blog.natelaffan.com.git");
    }

    #[test]
    fn other_hosts_and_bad_names_are_refused() {
        assert!(parse("https://gitlab.com/a/b").is_err());
        assert!(parse("laffan").is_err());
        assert!(parse("laffan/-bad").is_err());
        assert!(parse("").is_err());
    }

    #[test]
    fn pages_urls_follow_githubs_two_conventions() {
        assert_eq!(addr("Laffan", "notes").default_pages_url(), "https://laffan.github.io/notes/");
        assert_eq!(addr("laffan", "laffan.github.io").default_pages_url(), "https://laffan.github.io/");
    }

    #[test]
    fn a_public_url_splits_into_origin_and_base_path() {
        assert_eq!(
            split_public_url("https://blog.natelaffan.com"),
            Some(("https://blog.natelaffan.com".into(), "".into()))
        );
        assert_eq!(
            split_public_url("https://laffan.github.io/notes/"),
            Some(("https://laffan.github.io".into(), "/notes".into()))
        );
        assert_eq!(split_public_url("ftp://x"), None);
    }

    #[test]
    fn branch_names_follow_git() {
        assert!(checked_branch("main").is_ok());
        assert!(checked_branch("feature/new-post").is_ok());
        assert!(checked_branch("bad name").is_err());
        assert!(checked_branch("a..b").is_err());
        assert!(checked_branch("x.lock").is_err());
    }
}
