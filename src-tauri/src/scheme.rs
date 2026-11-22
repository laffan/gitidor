//! The `gitidor://` scheme: the preview's two ways of seeing a site.
//!
//! - `gitidor://local.<id>/<path>` serves a file from the clone, as it is on
//!   disk now. Inline images in the editor and the draft preview load through
//!   it, which is what makes both work offline.
//! - `gitidor://live.<id>/<path>` fetches `<path>` from the repository's
//!   public site and hands it back with one small script added. The script
//!   tells the app which page is showing (so the preview can offer "Edit this
//!   post" for it) and routes links that leave the site to the system browser.
//!
//! The repository is in the **host**, not the path, so that a page's
//! root-relative links (`/styles/main.css`) stay inside the same repository's
//! proxy. That form is what WebKit gives custom schemes on macOS, iOS and
//! Linux; Windows and Android rewrite custom schemes to `http://<scheme>.localhost`
//! and lose the host, so the live preview is Apple-and-Linux only — which is
//! every platform this app targets.
//!
//! Both are loaded in a sandboxed iframe without `allow-same-origin`, so a
//! page's own scripts run with an opaque origin and cannot reach the app's IPC.

use crate::repos;
use crate::store::{checked_id, clone_dir, safe_relative};
use tauri::http::{header, Request, Response, StatusCode};

pub fn handle(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let uri = request.uri();
    let host = uri.host().unwrap_or_default().to_string();
    let path = uri.path().to_string();
    let query = uri.query().map(|q| format!("?{q}")).unwrap_or_default();
    let result = match host.split_once('.') {
        Some(("local", id)) => local(id, &path),
        Some(("live", id)) => live(id, &path, &query),
        _ => Err((StatusCode::NOT_FOUND, format!("Unknown preview address {host}"))),
    };
    result.unwrap_or_else(|(status, message)| error_page(status, &message))
}

type Outcome = Result<Response<Vec<u8>>, (StatusCode, String)>;

fn local(id: &str, path: &str) -> Outcome {
    let id = checked_id(id).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let root = clone_dir(id).map_err(|e| (StatusCode::NOT_FOUND, e))?;
    let decoded = percent_encoding::percent_decode_str(path).decode_utf8_lossy().to_string();
    let rel = safe_relative(&decoded).map_err(|e| (StatusCode::FORBIDDEN, e))?;
    let mut file = root.join(rel);
    if file.is_dir() {
        file = file.join("index.html");
    }
    let bytes = std::fs::read(&file).map_err(|_| {
        let _scope = crate::events::scope(id);
        crate::events::warn("preview", format!("Not in the repository: {decoded}"));
        (StatusCode::NOT_FOUND, format!("{decoded} is not in this repository"))
    })?;
    Ok(respond(StatusCode::OK, mime_for(&decoded), bytes, "no-cache"))
}

const MAX_BODY: u64 = 32 * 1024 * 1024;

fn live(id: &str, path: &str, query: &str) -> Outcome {
    let id = checked_id(id).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let _scope = crate::events::scope(id);
    let started = std::time::Instant::now();
    let record = repos::get(id).map_err(|e| (StatusCode::NOT_FOUND, e))?;
    let (origin, _base) = crate::remote::split_public_url(&record.public_url)
        .ok_or((StatusCode::NOT_FOUND, "This repository has no public URL yet. Add one in its settings.".to_string()))?;
    let host = origin.split_once("://").map(|(_, h)| h.to_string()).unwrap_or_default();

    // Redirects are followed here rather than handed to WebKit, which does not
    // follow a redirect from a custom-scheme handler on every platform.
    let mut current = format!("{origin}{path}{query}");
    let mut final_path = path.to_string();
    let mut response = None;
    for _ in 0..6 {
        let reply = crate::http::proxy().get(&current).call().map_err(|e| {
            let message = crate::http::transport_error(&e, &host);
            crate::events::warn("preview", format!("{path}: {message}"));
            (StatusCode::BAD_GATEWAY, message)
        })?;
        let status = reply.status();
        if status.is_redirection() {
            let location = reply.headers().get(header::LOCATION).and_then(|l| l.to_str().ok()).unwrap_or_default().to_string();
            let next = resolve(&current, &location);
            if !next.starts_with(&format!("{origin}/")) && next != origin {
                return Ok(leaving_page(&next));
            }
            final_path = next[origin.len()..].split(['?', '#']).next().unwrap_or("/").to_string();
            crate::events::debug("preview", format!("{path} redirects to {final_path}"));
            current = next;
            continue;
        }
        response = Some(reply);
        break;
    }
    let mut reply = response.ok_or((StatusCode::BAD_GATEWAY, "Too many redirects".to_string()))?;
    let status = StatusCode::from_u16(reply.status().as_u16()).unwrap_or(StatusCode::OK);
    let mime = reply
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .unwrap_or_else(|| mime_for(path).to_string());
    let bytes = reply
        .body_mut()
        .with_config()
        .limit(MAX_BODY)
        .read_to_vec()
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("The page could not be read: {e}")))?;

    let lower = mime.to_ascii_lowercase();
    let line = format!("{} {final_path} → {} ({}, {} ms)", if lower.starts_with("text/html") { "Page" } else { "Asset" }, status.as_u16(), crate::events::size(bytes.len() as u64), started.elapsed().as_millis());
    if status.is_client_error() || status.is_server_error() {
        crate::events::warn("preview", line);
    } else if lower.starts_with("text/html") {
        crate::events::info("preview", line);
    } else {
        crate::events::debug("preview", line);
    }
    if lower.starts_with("text/html") {
        let html = String::from_utf8_lossy(&bytes).to_string();
        let redirected = (final_path != path).then_some(final_path.as_str());
        let page = inject(&rewrite_origin(&html, &host), id, redirected.unwrap_or(path), redirected.is_some());
        return Ok(respond(status, &mime, page.into_bytes(), "no-store"));
    }
    if lower.starts_with("text/css") {
        let css = rewrite_origin(&String::from_utf8_lossy(&bytes), &host);
        return Ok(respond(status, &mime, css.into_bytes(), "max-age=300"));
    }
    Ok(respond(status, &mime, bytes, "max-age=300"))
}

/// Absolute links to the site itself become root-relative, so they stay in
/// the proxy instead of leaving for the real site.
pub fn rewrite_origin(text: &str, host: &str) -> String {
    let mut out = text.replace(&format!("https://{host}"), "").replace(&format!("http://{host}"), "");
    for quote in ["\"", "'", "("] {
        out = out.replace(&format!("{quote}//{host}"), quote);
    }
    out
}

/// The navigation script, first thing in `<head>` so it runs before the page.
pub fn inject(html: &str, id: &str, path: &str, redirected: bool) -> String {
    let path_json = serde_json::to_string(path).unwrap_or_else(|_| "\"/\"".into());
    let base = if redirected { format!("<base href=\"gitidor://live.{id}{}\">", html_attr(path)) } else { String::new() };
    let script = format!(
        r#"{base}<script>(function(){{
var P={path_json};
function post(m){{try{{parent.postMessage(Object.assign({{gitidor:1}},m),"*");}}catch(e){{}}}}
function nav(){{post({{type:"nav",path:P+location.search,title:document.title}});}}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",nav);else nav();
addEventListener("message",function(e){{var d=e.data||{{}};if(!d.gitidor)return;
if(d.type==="back")history.back();if(d.type==="forward")history.forward();if(d.type==="reload")location.reload();}});
document.addEventListener("click",function(e){{var a=e.target&&e.target.closest&&e.target.closest("a[href]");if(!a)return;
var u;try{{u=new URL(a.getAttribute("href"),document.baseURI);}}catch(_){{return;}}
if(u.protocol==="gitidor:"){{if(a.target&&a.target!=="_self"){{e.preventDefault();location.href=u.href;}}return;}}
if(u.protocol==="http:"||u.protocol==="https:"||u.protocol==="mailto:"){{e.preventDefault();post({{type:"external",url:u.href}});}}
}},true);
}})();</script>"#
    );
    let lower = html.to_ascii_lowercase();
    if let Some(start) = lower.find("<head") {
        if let Some(close) = lower[start..].find('>') {
            let at = start + close + 1;
            return format!("{}{}{}", &html[..at], script, &html[at..]);
        }
    }
    format!("{script}{html}")
}

fn html_attr(text: &str) -> String {
    text.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;")
}

fn resolve(current: &str, location: &str) -> String {
    if location.starts_with("http://") || location.starts_with("https://") {
        return location.to_string();
    }
    let (scheme, rest) = current.split_once("://").unwrap_or(("https", current));
    let host_end = rest.find('/').unwrap_or(rest.len());
    let origin = format!("{scheme}://{}", &rest[..host_end]);
    if let Some(protocol_relative) = location.strip_prefix("//") {
        return format!("{scheme}://{protocol_relative}");
    }
    if location.starts_with('/') {
        return format!("{origin}{location}");
    }
    let path = &rest[host_end..];
    let dir = path.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    format!("{origin}{dir}/{location}")
}

fn respond(status: StatusCode, mime: &str, body: Vec<u8>, cache: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, cache)
        // The preview frame has an opaque origin; fonts and module scripts
        // from it are cross-origin requests and need this to load.
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn leaving_page(url: &str) -> Response<Vec<u8>> {
    let safe = html_attr(url);
    let body = format!(
        "<!doctype html><meta charset=utf-8><style>{STYLE}</style><main><h1>This page redirects off the site</h1>\
         <p>It goes to <code>{safe}</code>.</p><p><a href=\"{safe}\">Open it in the browser</a></p></main>\
         <script>document.querySelector('a').onclick=function(e){{e.preventDefault();parent.postMessage({{gitidor:1,type:'external',url:this.href}},'*');}};</script>"
    );
    respond(StatusCode::OK, "text/html; charset=utf-8", body.into_bytes(), "no-store")
}

const STYLE: &str = "body{font:15px/1.5 -apple-system,system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:90vh;\
color:#444;background:#fbfbfa}main{max-width:28em;padding:2em}h1{font-size:1.1em}code{font-size:.9em;word-break:break-all}\
@media(prefers-color-scheme:dark){body{color:#bbb;background:#1c1c1e}a{color:#7ab7ff}}";

fn error_page(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    let body = format!(
        "<!doctype html><meta charset=utf-8><style>{STYLE}</style><main><h1>Preview unavailable</h1><p>{}</p>\
         <p>The draft preview works offline.</p></main>",
        html_attr(message)
    );
    respond(status, "text/html; charset=utf-8", body.into_bytes(), "no-store")
}

pub fn mime_for(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or_default().to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "md" | "markdown" | "txt" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolute_links_to_the_site_stay_in_the_proxy() {
        let html = r#"<a href="https://blog.example.com/blog/x/">x</a><img src="//blog.example.com/a.jpg"><a href="https://other.com/">o</a>"#;
        let out = rewrite_origin(html, "blog.example.com");
        assert_eq!(out, r#"<a href="/blog/x/">x</a><img src="/a.jpg"><a href="https://other.com/">o</a>"#);
    }

    #[test]
    fn the_script_goes_first_in_head() {
        let out = inject("<!doctype html><html><HEAD><title>T</title></HEAD><body></body></html>", "abc", "/blog/x/", false);
        let head = out.find("<HEAD>").unwrap();
        let script = out.find("<script>").unwrap();
        let title = out.find("<title>").unwrap();
        assert!(head < script && script < title);
        assert!(out.contains(r#"var P="/blog/x/";"#));
        assert!(!out.contains("<base"));
        let redirected = inject("<head></head>", "abc", "/blog/x/", true);
        assert!(redirected.contains(r#"<base href="gitidor://live.abc/blog/x/">"#));
    }

    #[test]
    fn redirect_locations_resolve_like_a_browser() {
        assert_eq!(resolve("https://a.com/blog/x", "/blog/x/"), "https://a.com/blog/x/");
        assert_eq!(resolve("https://a.com/blog/x", "y/"), "https://a.com/blog/y/");
        assert_eq!(resolve("https://a.com/blog/x", "https://b.com/"), "https://b.com/");
        assert_eq!(resolve("https://a.com/x", "//c.com/z"), "https://c.com/z");
    }

    /// Through the real network: the proxy fetches a public page, keeps it
    /// root-relative and injects the navigation script; the local half
    /// serves a file from a clone. `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn live_and_local_against_a_real_site() {
        let root = std::env::temp_dir().join(format!("gitidor-scheme-{}", std::process::id()));
        crate::store::set_root(root.clone()).unwrap();
        let id = "abc123";
        let clone = crate::store::clone_dir(id).unwrap();
        std::fs::create_dir_all(clone.join("public/blog-images")).unwrap();
        std::fs::write(clone.join("public/blog-images/a b.jpg"), b"jpeg").unwrap();
        crate::repos::insert(crate::repos::RepoRecord {
            id: id.into(),
            public_url: std::env::var("GITIDOR_LIVE").unwrap_or_else(|_| "https://blog.natelaffan.com/".into()),
            ..Default::default()
        })
        .unwrap();

        let req = |uri: &str| tauri::http::Request::builder().uri(uri).body(Vec::new()).unwrap();
        let local = handle(req("gitidor://local.abc123/public/blog-images/a%20b.jpg"));
        assert_eq!(local.status(), 200);
        assert_eq!(local.headers()["content-type"], "image/jpeg");
        assert_eq!(local.body(), b"jpeg");
        assert_eq!(handle(req("gitidor://local.abc123/../secrets.json")).status(), 403);

        let page = handle(req("gitidor://live.abc123/blog/-crickets/"));
        let html = String::from_utf8_lossy(page.body());
        assert_eq!(page.status(), 200, "{html}");
        assert!(html.contains(r#"var P="/blog/-crickets/";"#));
        assert!(!html.contains("https://blog.natelaffan.com/blog/"), "absolute self-links were left in");
        println!("live page: {} bytes, title present: {}", html.len(), html.contains("<title>"));

        // A path without its trailing slash redirects on GitHub Pages; the
        // page must say where it ended up.
        let redirected = handle(req("gitidor://live.abc123/blog/-crickets"));
        let text = String::from_utf8_lossy(redirected.body());
        assert!(text.contains(r#"<base href="gitidor://live.abc123/blog/-crickets/">"#), "{}", &text[..text.len().min(400)]);
    }

    #[test]
    fn mime_types_for_site_assets() {
        assert_eq!(mime_for("a/b.JPG"), "image/jpeg");
        assert_eq!(mime_for("x.woff2"), "font/woff2");
        assert_eq!(mime_for("noext"), "application/octet-stream");
    }
}
