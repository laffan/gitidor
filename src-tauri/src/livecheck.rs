//! Whether the site profile's URLs are the ones the live site serves.
//!
//! A route is a claim — "`content/photos/0007.md` is published at
//! `/photo/7/`" — and the published site can settle it. For each content
//! folder a few posts that GitHub already has are tried at the URLs the
//! profile gives them: a page that is there and has the post's words in it
//! confirms the route; a 404, or a page without them, refutes it. The words
//! are compared as runs of three, after the page's tags and the markdown's
//! syntax are taken off, so templates and rendering do not get in the way.
//!
//! The same requests give the AI pass something concrete to work from (see
//! `ai.rs`): URLs the site really serves, from its sitemap or its home page,
//! and, after a first answer, what the site said about each URL it implied.

use crate::files;
use crate::site::{self, RouteCheck, SampleCheck, SiteProfile};
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// Posts tried per folder.
const SAMPLES: usize = 3;
const MAX_PAGE: u64 = 4 * 1024 * 1024;

/// A page as the site served it, after redirects.
pub struct Page {
    pub status: u16,
    /// The path it ended up at, below the origin.
    pub path: String,
    pub body: String,
}

/// `origin` and `base` as `remote::split_public_url` gives them.
pub struct Site {
    pub origin: String,
    pub base: String,
}

impl Site {
    pub fn from_public_url(url: &str) -> Option<Site> {
        crate::remote::split_public_url(url).map(|(origin, base)| Site { origin, base })
    }

    fn host(&self) -> &str {
        self.origin.split_once("://").map(|(_, h)| h).unwrap_or(&self.origin)
    }

    /// GET a path below the base, following redirects that stay on the site.
    pub fn get(&self, url_path: &str) -> Result<Page, String> {
        let path = if url_path.starts_with('/') { url_path.to_string() } else { format!("/{url_path}") };
        let mut current = format!("{}{}{}", self.origin, self.base, path);
        for _ in 0..6 {
            let mut reply = crate::http::proxy().get(&current).call().map_err(|e| crate::http::transport_error(&e, self.host()))?;
            let status = reply.status().as_u16();
            if (300..400).contains(&status) {
                let location = reply.headers().get("location").and_then(|l| l.to_str().ok()).unwrap_or_default().to_string();
                let next = crate::scheme::resolve(&current, &location);
                if !next.starts_with(&format!("{}/", self.origin)) {
                    return Ok(Page { status, path: next, body: String::new() });
                }
                current = next;
                continue;
            }
            let body = reply.body_mut().with_config().limit(MAX_PAGE).read_to_vec().unwrap_or_default();
            let landed = current[self.origin.len()..].split(['?', '#']).next().unwrap_or("/").to_string();
            return Ok(Page { status, path: landed, body: String::from_utf8_lossy(&body).to_string() });
        }
        Err(format!("{path} redirects too many times"))
    }
}

/// The route that gives a content folder's files their URLs: the deepest
/// route at or above the folder, else the first one inside it.
fn route_for_folder<'a>(profile: &'a SiteProfile, folder: &str) -> Option<&'a site::Route> {
    let above = profile
        .routes
        .iter()
        .filter(|r| r.folder.is_empty() || folder == r.folder || folder.starts_with(&format!("{}/", r.folder)))
        .max_by_key(|r| r.folder.len());
    above.or_else(|| profile.routes.iter().find(|r| r.folder.starts_with(&format!("{folder}/"))))
}

/// Try each folder's routes on the live site. `unpublished` are the files
/// GitHub does not have yet (changed here, or in unpushed commits): the site
/// cannot have them, so they are not tried.
pub fn check(root: &Path, profile: &SiteProfile, site: &Site, folders: &[String], unpublished: &HashSet<String>) -> Vec<RouteCheck> {
    let folders: Vec<String> = if folders.is_empty() {
        profile.routes.iter().map(|r| r.folder.clone()).collect()
    } else {
        folders.to_vec()
    };
    let empty = HashMap::new();
    let mut out = Vec::new();
    for folder in folders {
        let route = route_for_folder(profile, &folder);
        let mut check = RouteCheck {
            folder: folder.clone(),
            pattern: route.map(|r| r.pattern.clone()).unwrap_or_default(),
            capture: route.map(|r| r.capture.clone()).unwrap_or_default(),
            ..Default::default()
        };
        if route.is_none() {
            check.outcome = "failed".into();
            check.message = format!("No route gives the files in {folder} a URL.");
            out.push(check);
            continue;
        }
        let list = files::list_folder(root, &folder, Some(profile), &empty).unwrap_or_default();
        let candidates: Vec<&files::FileEntry> = list.iter().filter(|f| !f.draft && !unpublished.contains(&f.path)).collect();
        let with_url: Vec<&files::FileEntry> = candidates.iter().copied().filter(|f| f.url.is_some()).collect();
        if candidates.is_empty() {
            check.outcome = "unchecked".into();
            check.message = format!("Nothing in {folder} is on GitHub yet to try.");
            out.push(check);
            continue;
        }
        if with_url.is_empty() {
            check.outcome = "failed".into();
            check.message = format!("No post in {folder} gets a URL from `{}`.", check.pattern);
            out.push(check);
            continue;
        }
        let picks = spread(&with_url, SAMPLES);
        let samples: Vec<SampleCheck> = std::thread::scope(|s| {
            let handles: Vec<_> = picks
                .iter()
                .map(|f| {
                    let url = f.url.clone().unwrap_or_default();
                    let text = std::fs::read_to_string(root.join(&f.path)).unwrap_or_default();
                    let path = f.path.clone();
                    s.spawn(move || try_sample(site, path, url, &text))
                })
                .collect();
            handles.into_iter().filter_map(|h| h.join().ok()).collect()
        });
        summarise(&mut check, samples);
        out.push(check);
    }
    out
}

/// Up to `n` entries spread through a newest-first list, leaving out the very
/// newest when there is a choice: it is the one most likely still building.
fn spread<'a>(list: &[&'a files::FileEntry], n: usize) -> Vec<&'a files::FileEntry> {
    let len = list.len();
    let mut idx: Vec<usize> = if len <= n {
        (0..len).collect()
    } else {
        vec![1, len / 2, len - 1]
    };
    idx.truncate(n);
    idx.dedup();
    idx.into_iter().map(|i| list[i]).collect()
}

fn try_sample(site: &Site, path: String, url: String, markdown: &str) -> SampleCheck {
    let mut sample = SampleCheck { path, url: url.clone(), ..Default::default() };
    match site.get(&url) {
        Err(e) => {
            sample.outcome = "error".into();
            crate::events::debug("preview", format!("{url}: {e}"));
        }
        Ok(page) => {
            sample.status = page.status;
            let moved = site::normalize_url_path(&page.path) != site::normalize_url_path(&format!("{}{}", site.base, url));
            sample.outcome = if page.status == 404 || page.status == 410 {
                "missing"
            } else if page.status >= 400 {
                "error"
            } else if moved {
                // Somewhere else answered: not the page this URL names.
                "different"
            } else {
                match shows_post(markdown, &page.body) {
                    Some(true) => "found",
                    Some(false) => "different",
                    None => "reachable",
                }
            }
            .into();
        }
    }
    sample
}

fn summarise(check: &mut RouteCheck, samples: Vec<SampleCheck>) {
    let count = |o: &str| samples.iter().filter(|s| s.outcome == o).count();
    let good = count("found") + count("reachable");
    let bad = count("missing") + count("different");
    let total = samples.len();
    check.outcome = if total == 0 || count("error") == total {
        "unchecked"
    } else if bad == 0 && good > 0 {
        "ok"
    } else if good > 0 {
        "mixed"
    } else {
        "failed"
    }
    .into();
    check.message = match check.outcome.as_str() {
        "unchecked" => "The live site could not be reached.".to_string(),
        "ok" => format!("{good} of {total} post{} found at {} URL{} on the live site.", plural(total), if total == 1 { "its" } else { "their" }, plural(total)),
        _ => {
            let first_bad = samples.iter().find(|s| s.outcome == "missing" || s.outcome == "different");
            let why = first_bad.map(|s| format!("{} → {}: {}", s.path, s.url, describe(s))).unwrap_or_default();
            format!("{good} of {total} post{} found on the live site. {why}", plural(total))
        }
    };
    check.samples = samples;
}

fn plural(n: usize) -> &'static str {
    if n == 1 {
        ""
    } else {
        "s"
    }
}

/// One sample's outcome, in a few words.
pub fn describe(s: &SampleCheck) -> String {
    match s.outcome.as_str() {
        "found" => "found".into(),
        "reachable" => format!("a page is there ({})", s.status),
        "different" => "the page there is not this post".into(),
        "missing" => format!("the site has no page there ({})", s.status),
        _ if s.status > 0 => format!("the site answered {}", s.status),
        _ => "the site could not be reached".into(),
    }
}

// ── comparing a page with a post ────────────────────────────────────────────

/// Whether `html` shows the post: `Some(true)` when most of the post's first
/// three-word runs are on the page, `None` when the post has no words to look
/// for (a photo with no caption and no title).
pub fn shows_post(markdown: &str, html: &str) -> Option<bool> {
    let (title, body) = post_words(markdown);
    let page = words(&page_text(html));
    if body.len() >= 3 {
        let page_runs: HashSet<String> = page.windows(3).map(|w| w.join(" ")).collect();
        let runs: Vec<String> = body.iter().take(60).collect::<Vec<_>>().windows(3).map(|w| w.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(" ")).collect();
        let hits = runs.iter().filter(|r| page_runs.contains(*r)).count();
        return Some(hits * 2 >= runs.len());
    }
    let page_set: HashSet<&String> = page.iter().collect();
    let look_for: Vec<&String> = if body.is_empty() { title.iter().collect() } else { body.iter().collect() };
    if look_for.is_empty() {
        return None;
    }
    Some(look_for.iter().all(|w| page_set.contains(w)))
}

/// The title's words and the body's, with frontmatter, link targets, image
/// syntax and HTML tags taken off.
fn post_words(markdown: &str) -> (Vec<String>, Vec<String>) {
    let front = crate::frontmatter::parse(markdown);
    let body = strip_frontmatter(markdown);
    let mut text = String::with_capacity(body.len());
    let mut chars = body.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            // `![alt](src)`: the alt text is not on the page as text.
            '!' if chars.peek() == Some(&'[') => {
                skip_until(&mut chars, ']');
                if chars.peek() == Some(&'(') {
                    skip_until(&mut chars, ')');
                }
            }
            // `](target)` after link text.
            ']' if chars.peek() == Some(&'(') => {
                skip_until(&mut chars, ')');
                text.push(' ');
            }
            '<' => {
                skip_until(&mut chars, '>');
                text.push(' ');
            }
            _ => text.push(c),
        }
    }
    let text: String = text.split_whitespace().filter(|w| !w.starts_with("http://") && !w.starts_with("https://")).collect::<Vec<_>>().join(" ");
    (words(front.get("title").unwrap_or_default()), words(&text))
}

fn skip_until(chars: &mut std::iter::Peekable<std::str::Chars>, end: char) {
    for c in chars.by_ref() {
        if c == end {
            break;
        }
    }
}

fn strip_frontmatter(text: &str) -> &str {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    for fence in ["---", "+++"] {
        if let Some(rest) = text.strip_prefix(fence).filter(|r| r.starts_with('\n') || r.starts_with("\r\n")) {
            if let Some(end) = rest.find(&format!("\n{fence}")) {
                let after = &rest[end + 1 + fence.len()..];
                return after.split_once('\n').map(|(_, b)| b).unwrap_or("");
            }
        }
    }
    text
}

/// A page's readable text: no scripts, styles, comments or tags, entities
/// decoded.
pub fn page_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 2);
    let lower = html.to_ascii_lowercase();
    let mut i = 0;
    while i < html.len() {
        let rest = &lower[i..];
        if rest.starts_with("<script") || rest.starts_with("<style") {
            let close = if rest.starts_with("<script") { "</script>" } else { "</style>" };
            i += rest.find(close).map(|e| e + close.len()).unwrap_or(rest.len());
            out.push(' ');
        } else if rest.starts_with("<!--") {
            i += rest.find("-->").map(|e| e + 3).unwrap_or(rest.len());
        } else if rest.starts_with('<') {
            i += rest.find('>').map(|e| e + 1).unwrap_or(rest.len());
            out.push(' ');
        } else {
            let next = rest.find('<').unwrap_or(rest.len());
            out.push_str(&html[i..i + next]);
            i += next;
        }
    }
    decode_entities(&out)
}

fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp..];
        let end = rest.find(';').filter(|e| *e <= 10);
        let decoded = end.and_then(|e| {
            let name = &rest[1..e];
            let ch = match name {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some(' '),
                "rsquo" | "lsquo" => Some('\''),
                "rdquo" | "ldquo" => Some('"'),
                "mdash" => Some('—'),
                "ndash" => Some('–'),
                "hellip" => Some('…'),
                _ => name
                    .strip_prefix("#x")
                    .or_else(|| name.strip_prefix("#X"))
                    .and_then(|h| u32::from_str_radix(h, 16).ok())
                    .or_else(|| name.strip_prefix('#').and_then(|d| d.parse().ok()))
                    .and_then(char::from_u32),
            }?;
            Some((ch, e))
        });
        match decoded {
            Some((ch, e)) => {
                out.push(ch);
                rest = &rest[e + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Lower-case words: letters and digits, with apostrophes dropped so
/// "don't" and "don’t" compare equal.
fn words(text: &str) -> Vec<String> {
    text.split(|c: char| !(c.is_alphanumeric() || c == '\'' || c == '’'))
        .map(|w| w.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect::<String>())
        .filter(|w| !w.is_empty())
        .collect()
}

// ── what the site serves ────────────────────────────────────────────────────

/// URLs the live site serves, for the AI to match file names against: the
/// sitemap's, or else the links on the home page (after a redirect or a
/// `<meta http-equiv="refresh">`, which is how some sites point at their
/// newest post). Paths below the base, at most `limit`.
pub fn site_urls(site: &Site, limit: usize) -> Vec<String> {
    for name in ["/sitemap.xml", "/sitemap-index.xml", "/sitemap_index.xml"] {
        let Ok(page) = site.get(name) else { return Vec::new() };
        if page.status != 200 || !page.body.contains("<loc>") {
            continue;
        }
        let mut locs = tag_values(&page.body, "loc");
        if page.body.contains("<sitemapindex") {
            let child = locs.first().map(|l| below_base(site, l)).unwrap_or_default();
            locs = child.and_then(|c| site.get(&c).ok()).map(|p| tag_values(&p.body, "loc")).unwrap_or_default();
        }
        let mut out: Vec<String> = locs.iter().filter_map(|l| below_base(site, l)).collect();
        out.dedup();
        out.truncate(limit);
        if !out.is_empty() {
            return out;
        }
    }
    let Ok(mut page) = site.get("/") else { return Vec::new() };
    let mut out = Vec::new();
    if let Some(target) = meta_refresh(&page.body).and_then(|t| below_base(site, &t)) {
        out.push(target.clone());
        if let Ok(next) = site.get(&target) {
            page = next;
        }
    }
    for link in links(&page.body) {
        if let Some(path) = below_base(site, &link) {
            if !out.contains(&path) && looks_like_page(&path) {
                out.push(path);
            }
        }
        if out.len() >= limit {
            break;
        }
    }
    out
}

fn tag_values(xml: &str, tag: &str) -> Vec<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(i) = rest.find(&open) {
        rest = &rest[i + open.len()..];
        let Some(end) = rest.find(&close) else { break };
        out.push(decode_entities(rest[..end].trim()));
        rest = &rest[end..];
    }
    out
}

fn meta_refresh(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let at = lower.find("http-equiv=\"refresh\"").or_else(|| lower.find("http-equiv='refresh'"))?;
    let tag_end = lower[at..].find('>')? + at;
    let tag = &html[at..tag_end];
    let url_at = tag.to_ascii_lowercase().find("url=")? + 4;
    let target: String = tag[url_at..].chars().take_while(|c| !matches!(c, '"' | '\'' | ';' | '>' | ' ')).collect();
    (!target.is_empty()).then_some(target)
}

/// `href`s, and quoted root-relative paths anywhere in the page (a script
/// that sets `location.href = '/photo/32/'` counts).
fn links(html: &str) -> Vec<String> {
    let mut out = Vec::new();
    for quote in ['"', '\'', '`'] {
        for part in html.split(quote).skip(1).step_by(2) {
            let part = part.trim();
            let rooted = part.starts_with('/') && !part.starts_with("//");
            let absolute = part.starts_with("https://") || part.starts_with("http://");
            if (rooted || absolute) && part.len() < 300 && !part.contains(char::is_whitespace) && !part.contains("${") && !part.contains("{{") {
                out.push(part.to_string());
            }
        }
    }
    out
}

/// A path below the site's base, or `None` for another site.
fn below_base(site: &Site, url: &str) -> Option<String> {
    let path = if let Some(rest) = url.strip_prefix(&site.origin) {
        if !(rest.is_empty() || rest.starts_with('/')) {
            return None;
        }
        rest.to_string()
    } else if url.starts_with('/') && !url.starts_with("//") {
        url.to_string()
    } else {
        let other = url.replace("http://", "https://");
        let own = site.origin.replace("http://", "https://");
        if other.starts_with(&format!("{own}/")) {
            other[own.len()..].to_string()
        } else {
            return None;
        }
    };
    let path = path.split('#').next().unwrap_or_default().to_string();
    let path = if path.is_empty() { "/".to_string() } else { path };
    if site.base.is_empty() {
        Some(path)
    } else {
        path.strip_prefix(&site.base).filter(|p| p.is_empty() || p.starts_with('/')).map(|p| if p.is_empty() { "/".to_string() } else { p.to_string() })
    }
}

/// Pages, not stylesheets, scripts, images or feeds.
fn looks_like_page(path: &str) -> bool {
    let last = path.split('?').next().unwrap_or_default().rsplit('/').next().unwrap_or_default();
    match last.rsplit_once('.') {
        Some((_, ext)) => matches!(ext.to_ascii_lowercase().as_str(), "html" | "htm" | "php"),
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_shows_a_post_when_its_word_runs_are_there() {
        let post = "---\nfilename: APC_1884.jpg\nlocation: Kimball, NE\n---\n\"And they shall scourge him, and put him to death: and the third day he shall rise again.\"\n- Luke 18:33";
        let page = "<html><head><title>The Drip Drip Photo Book</title><script>var x='death and the third'</script></head><body><main><img src=\"/media/photos/APC_1884.jpg\"><span>1</span><p>&quot;And they shall scourge him, and put him to death: and the third day he shall rise again.&quot;</p><ul><li>Luke 18:33</li></ul></main></body></html>";
        assert_eq!(shows_post(post, page), Some(true));
        let other = "<html><body><p>Twin stripes across the Wyoming sky.</p></body></html>";
        assert_eq!(shows_post(post, other), Some(false));
        // A short caption is looked for word by word.
        assert_eq!(shows_post("---\nx: 1\n---\nTwin stripes.", other), Some(true));
        // Nothing to look for: the page cannot be told apart.
        assert_eq!(shows_post("---\nfilename: a.jpg\n---\n", other), None);
    }

    #[test]
    fn markdown_syntax_and_link_targets_are_not_looked_for() {
        let (title, body) = post_words("---\ntitle: Crickets\n---\nThe [Low Anthem](https://example.com/x) played. ![a photo](/images/a.jpg) <em>Loud</em>.");
        assert_eq!(title, vec!["crickets"]);
        assert_eq!(body, vec!["the", "low", "anthem", "played", "loud"]);
        assert_eq!(page_text("<p>Fish &amp; chips&#8217;s &#x41;</p><!-- note -->"), " Fish & chips’s A ");
    }

    #[test]
    fn site_urls_come_from_links_and_refreshes() {
        let html = r#"<meta http-equiv="refresh" content="0; url=/photo/33/"><script>window.location.href = "/photo/33/";</script>"#;
        assert_eq!(meta_refresh(html).as_deref(), Some("/photo/33/"));
        let page = r#"<a href="/about/">about</a><link href="/css/a.css"><script>go('/photo/32/'); x = `/photo/${n}/`;</script><a href="https://elsewhere.com/x">x</a><a href="https://dripdrip.example/photo/31/">31</a>"#;
        let site = Site { origin: "https://dripdrip.example".into(), base: String::new() };
        let found: Vec<String> = links(page).iter().filter_map(|l| below_base(&site, l)).filter(|p| looks_like_page(p)).collect();
        assert!(found.contains(&"/about/".to_string()));
        assert!(found.contains(&"/photo/32/".to_string()));
        assert!(found.contains(&"/photo/31/".to_string()));
        assert!(!found.iter().any(|p| p.contains("css") || p.contains("elsewhere") || p.contains("${")));
        let project = Site { origin: "https://owner.github.io".into(), base: "/blog".into() };
        assert_eq!(below_base(&project, "https://owner.github.io/blog/a/").as_deref(), Some("/a/"));
        assert_eq!(below_base(&project, "/other/a/"), None);
        assert_eq!(tag_values("<url><loc>https://x/a/</loc></url><url><loc>https://x/b/</loc></url>", "loc"), vec!["https://x/a/", "https://x/b/"]);
    }

    #[test]
    fn outcomes_add_up_to_a_verdict() {
        let s = |o: &str| SampleCheck { path: "p.md".into(), url: "/p/".into(), status: if o == "missing" { 404 } else { 200 }, outcome: o.into() };
        let mut c = RouteCheck::default();
        summarise(&mut c, vec![s("found"), s("found"), s("reachable")]);
        assert_eq!(c.outcome, "ok");
        summarise(&mut c, vec![s("found"), s("missing")]);
        assert_eq!(c.outcome, "mixed");
        assert!(c.message.contains("no page there (404)"), "{}", c.message);
        summarise(&mut c, vec![s("missing"), s("different")]);
        assert_eq!(c.outcome, "failed");
        summarise(&mut c, vec![s("error")]);
        assert_eq!(c.outcome, "unchecked");
    }

    /// The real sites, through the network: the blog's rule-based routes
    /// hold; dripdrip's hold once its pattern is the one its function makes.
    /// `GITIDOR_BLOG` and `GITIDOR_DRIPDRIP` point at checkouts.
    #[test]
    #[ignore]
    fn the_real_sites() {
        if let Ok(blog) = std::env::var("GITIDOR_BLOG") {
            let root = std::path::PathBuf::from(blog);
            let p = site::detect(&root);
            let site = Site::from_public_url(&p.public_url_hint).unwrap();
            let checks = check(&root, &p, &site, &["posts".into()], &HashSet::new());
            println!("blog: {checks:#?}");
            assert_eq!(checks[0].outcome, "ok");
        }
        if let Ok(drip) = std::env::var("GITIDOR_DRIPDRIP") {
            let root = std::path::PathBuf::from(drip);
            let mut p = site::detect(&root);
            let site = Site::from_public_url(&p.public_url_hint).unwrap();
            let before = check(&root, &p, &site, &["content/photos".into()], &HashSet::new());
            println!("dripdrip, by rule: {before:#?}");
            assert_eq!(before[0].outcome, "failed");
            println!("dripdrip URLs: {:?}", site_urls(&site, 40));
            p.routes = vec![site::Route { folder: "content/photos".into(), pattern: "/photo/{stem|number}/".into(), ..Default::default() }];
            let after = check(&root, &p, &site, &["content/photos".into()], &HashSet::new());
            println!("dripdrip, corrected: {after:#?}");
            assert_eq!(after[0].outcome, "ok");
        }
    }
}
