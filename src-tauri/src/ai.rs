//! The AI-assisted half of site detection, and the key check behind the
//! Settings sheet's Test button.
//!
//! Two providers, both called over raw HTTP from Rust (there is no official
//! Rust SDK for either), with the key read from `secrets.json` at the moment of
//! the call and never sent to the webview:
//!
//! - **Anthropic**: `POST /v1/messages`, structured output through
//!   `output_config.format` with a JSON schema, `fallbacks: "default"` so a
//!   declined request is retried server-side on the recommended model, and an
//!   explicit `effort`.
//! - **OpenAI**: `POST /v1/responses` with `text.format` set to a strict JSON
//!   schema. The model is whatever the person picked from their own account's
//!   model list — that list moves too often for this file to pin a name.
//!
//! The model is asked for exactly the shape `site::SiteProfile` has, and what
//! comes back goes through `site::sanitize` before it is saved: a folder that
//! does not exist or a path that leaves the repository is dropped, not trusted.

use crate::http;
use crate::livecheck;
use crate::site::{self, SiteProfile};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::Path;

pub const DEFAULT_ANTHROPIC_MODEL: &str = "claude-opus-5-5";
const ANTHROPIC_VERSION: &str = "2026-10-21";
const ANTHROPIC_FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";

/// Models whose requests accept `fallbacks: "default"`.
fn supports_fallbacks(model: &str) -> bool {
    ["claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"].contains(&model)
}

/// Older models reject `output_config.effort`; everything current takes it.
fn supports_effort(model: &str) -> bool {
    !(model.contains("haiku-4") || model.contains("sonnet-4-5") || model.contains("claude-3"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyTest {
    pub models: Vec<String>,
    pub message: String,
}

fn key_for(provider: &str) -> Result<String, String> {
    let secrets = crate::secrets::load()?;
    let key = match provider {
        "anthropic" => secrets.anthropic_key,
        "openai" => secrets.openai_key,
        other => return Err(format!("{other} is not a provider gitidor knows")),
    };
    if key.is_empty() {
        Err(format!("No {} key is saved. Add one under Settings → AI.", label(provider)))
    } else {
        Ok(key)
    }
}

fn label(provider: &str) -> &'static str {
    if provider == "openai" {
        "OpenAI"
    } else {
        "Anthropic"
    }
}

/// Check a saved key by listing the models it can use. Costs nothing.
pub fn test_key(provider: &str) -> Result<KeyTest, String> {
    let key = key_for(provider)?;
    let request = match provider {
        "anthropic" => http::api()
            .get("https://api.anthropic.com/v1/models?limit=100")
            .header("x-api-key", &key)
            .header("anthropic-version", ANTHROPIC_VERSION),
        _ => http::api().get("https://api.openai.com/v1/models").header("Authorization", &format!("Bearer {key}")),
    };
    let mut response = request.call().map_err(|e| http::transport_error(&e, label(provider)))?;
    let status = response.status().as_u16();
    let text = response.body_mut().read_to_string().unwrap_or_default();
    if status != 200 {
        return Err(match status {
            401 => format!("{} did not accept that key.", label(provider)),
            403 => format!("{} accepted the key but it is not allowed to list models.", label(provider)),
            _ => format!("{} answered {status}: {}", label(provider), http::error_message(&text)),
        });
    }
    let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let mut models: Vec<String> = body
        .get("data")
        .and_then(|d| d.as_array())
        .map(|list| list.iter().filter_map(|m| m.get("id")?.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    if provider == "openai" {
        models.retain(|id| is_openai_text_model(id));
        models.sort_by(|a, b| b.cmp(a));
    }
    Ok(KeyTest { message: format!("Key works — {} models available.", models.len()), models })
}

/// OpenAI's model list includes audio, image, embedding and moderation models;
/// none of them can answer a structured text request.
fn is_openai_text_model(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    let text_family = id.starts_with("gpt-") || id.starts_with('o');
    let excluded = ["audio", "realtime", "image", "tts", "embedding", "whisper", "dall", "transcribe", "moderation", "search", "instruct"];
    text_family && !excluded.iter().any(|x| id.contains(x))
}

/// One message of a conversation: the person's side, or the model's.
#[derive(Debug, Clone)]
pub struct Turn {
    pub role: &'static str,
    pub text: String,
}

impl Turn {
    pub fn user(text: impl Into<String>) -> Turn {
        Turn { role: "user", text: text.into() }
    }
    pub fn assistant(text: impl Into<String>) -> Turn {
        Turn { role: "assistant", text: text.into() }
    }
}

/// Ask the configured provider for JSON matching `schema`, over a
/// conversation that starts and ends with the person's turn: a question, or
/// a question, the model's answer, and what was wrong with it.
pub fn complete_json_turns(system: &str, turns: &[Turn], schema: &Value) -> Result<Value, String> {
    let settings = crate::settings::load().unwrap_or_default();
    match settings.ai.provider.as_str() {
        "anthropic" => {
            let model = if settings.ai.anthropic_model.is_empty() { DEFAULT_ANTHROPIC_MODEL.to_string() } else { settings.ai.anthropic_model };
            anthropic(&key_for("anthropic")?, &model, system, turns, schema)
        }
        "openai" => {
            if settings.ai.openai_model.is_empty() {
                return Err("Choose an OpenAI model under Settings → AI (press Test to load the list).".into());
            }
            openai(&key_for("openai")?, &settings.ai.openai_model, system, turns, schema)
        }
        _ => Err("No AI provider is set up. Choose one under Settings → AI.".into()),
    }
}

fn anthropic(key: &str, model: &str, system: &str, turns: &[Turn], schema: &Value) -> Result<Value, String> {
    let mut output_config = json!({ "format": { "type": "json_schema", "schema": schema } });
    if supports_effort(model) {
        // A structured read of config files, not a hard reasoning problem.
        output_config["effort"] = json!("medium");
    }
    let mut body = json!({
        "model": model,
        "max_tokens": 16000,
        "system": system,
        "messages": turns.iter().map(|t| json!({ "role": t.role, "content": t.text })).collect::<Vec<_>>(),
        "output_config": output_config,
    });
    let mut request = http::api()
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json");
    if supports_fallbacks(model) {
        body["fallbacks"] = json!("default");
        request = request.header("anthropic-beta", ANTHROPIC_FALLBACK_BETA);
    }
    crate::events::info("ai", format!("Asking Anthropic ({model}) about the site's structure"));
    let started = std::time::Instant::now();
    let mut response = request.send_json(&body).map_err(|e| http::transport_error(&e, "Anthropic"))?;
    let status = response.status().as_u16();
    let text = response.body_mut().with_config().limit(8 * 1024 * 1024).read_to_string().unwrap_or_default();
    if status != 200 {
        return Err(format!("Anthropic answered {status}: {}", http::error_message(&text)));
    }
    let reply: Value = serde_json::from_str(&text).map_err(|e| format!("Anthropic's answer could not be read: {e}"))?;
    let served = reply.get("model").and_then(|m| m.as_str()).unwrap_or(model);
    crate::events::info(
        "ai",
        format!(
            "Anthropic answered in {:.1} s — {} tokens in, {} out{}",
            started.elapsed().as_secs_f32(),
            reply.pointer("/usage/input_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
            reply.pointer("/usage/output_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
            if served != model { format!(" (served by {served} after a fallback)") } else { String::new() },
        ),
    );
    parse_anthropic(&reply)
}

/// The JSON a Messages API reply carries in its text blocks — after the
/// stop reason says the answer is whole. `thinking` and `fallback` blocks are
/// skipped; only `text` is the answer.
fn parse_anthropic(reply: &Value) -> Result<Value, String> {
    match reply.get("stop_reason").and_then(|s| s.as_str()) {
        Some("refusal") => return Err("The model declined to answer this request.".into()),
        Some("max_tokens") => return Err("The model's answer was cut off before it finished.".into()),
        _ => {}
    }
    let answer: String = reply
        .get("content")
        .and_then(|c| c.as_array())
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect()
        })
        .unwrap_or_default();
    serde_json::from_str(&answer).map_err(|e| format!("The model's answer was not the JSON asked for: {e}"))
}

fn openai(key: &str, model: &str, system: &str, turns: &[Turn], schema: &Value) -> Result<Value, String> {
    let mut input = vec![json!({ "role": "system", "content": system })];
    input.extend(turns.iter().map(|t| json!({ "role": t.role, "content": t.text })));
    let body = json!({
        "model": model,
        "input": input,
        "text": { "format": { "type": "json_schema", "name": "site_profile", "schema": schema, "strict": true } },
    });
    crate::events::info("ai", format!("Asking OpenAI ({model}) about the site's structure"));
    let started = std::time::Instant::now();
    let mut response = http::api()
        .post("https://api.openai.com/v1/responses")
        .header("Authorization", &format!("Bearer {key}"))
        .header("content-type", "application/json")
        .send_json(&body)
        .map_err(|e| http::transport_error(&e, "OpenAI"))?;
    let status = response.status().as_u16();
    let text = response.body_mut().with_config().limit(8 * 1024 * 1024).read_to_string().unwrap_or_default();
    if status != 200 {
        return Err(format!("OpenAI answered {status}: {}", http::error_message(&text)));
    }
    let reply: Value = serde_json::from_str(&text).map_err(|e| format!("OpenAI's answer could not be read: {e}"))?;
    crate::events::info(
        "ai",
        format!(
            "OpenAI answered in {:.1} s — {} tokens in, {} out",
            started.elapsed().as_secs_f32(),
            reply.pointer("/usage/input_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
            reply.pointer("/usage/output_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
        ),
    );
    parse_openai(&reply)
}

/// The JSON a Responses API reply carries in its `message` items' `output_text`
/// parts, refusing an incomplete answer or a refusal part.
fn parse_openai(reply: &Value) -> Result<Value, String> {
    if reply.get("status").and_then(|s| s.as_str()) == Some("incomplete") {
        return Err("The model's answer was cut off before it finished.".into());
    }
    let mut answer = String::new();
    for item in reply.get("output").and_then(|o| o.as_array()).into_iter().flatten() {
        if item.get("type").and_then(|t| t.as_str()) != Some("message") {
            continue;
        }
        for part in item.get("content").and_then(|c| c.as_array()).into_iter().flatten() {
            match part.get("type").and_then(|t| t.as_str()) {
                Some("output_text") => answer.push_str(part.get("text").and_then(|t| t.as_str()).unwrap_or_default()),
                Some("refusal") => return Err("The model declined to answer this request.".into()),
                _ => {}
            }
        }
    }
    serde_json::from_str(&answer).map_err(|e| format!("The model's answer was not the JSON asked for: {e}"))
}

// ── site detection ──────────────────────────────────────────────────────────

pub fn profile_schema() -> Value {
    let string = json!({ "type": "string" });
    let strings = json!({ "type": "array", "items": { "type": "string" } });
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["generator", "routes", "assets", "stylesheets", "suggestedFolders", "notes"],
        "properties": {
            "generator": string,
            "routes": { "type": "array", "items": {
                "type": "object", "additionalProperties": false, "required": ["folder", "pattern", "capture"],
                "properties": { "folder": string, "pattern": string, "capture": string }
            }},
            "assets": { "type": "array", "items": {
                "type": "object", "additionalProperties": false, "required": ["urlPrefix", "repoPath"],
                "properties": { "urlPrefix": string, "repoPath": string }
            }},
            "stylesheets": strings,
            "suggestedFolders": strings,
            "notes": string,
        }
    })
}

const SYSTEM: &str = "You are helping a markdown editor understand a static website's source repository, so that its \
preview can open the live page of any post and name the source file of any live page. From the repository listing, \
config files, routing code, sample posts and the URLs the live site serves, work out:\n\
1. routes: for each folder of markdown posts, the URL pattern the site publishes a post at. When the URL is computed \
by code (an Eleventy permalink function or collection, a Next.js, Astro or Gatsby route file, a Hugo permalink \
setting), read the code and express what it computes in the pattern language below.\n\
2. assets: how site URL prefixes (as written in posts, e.g. /images/blog/) map to folders in the repository \
(e.g. public/blog-images/). Include a catch-all '/' entry for the folder the site root is copied from.\n\
3. stylesheets: repository paths of the site's main CSS files, if any are plain .css.\n\
4. suggestedFolders: the folders that hold posts a person would edit, most important first.\n\
\n\
Pattern language. Tokens: {path} (path inside the folder without extension, /index dropped), {stem} (last segment \
of {path}), {fileSlug} ({stem} with a leading YYYY-MM-DD- removed, exactly one hyphen with it, as Eleventy's \
page.fileSlug and Jekyll's :title do), {slug} (frontmatter slug, else {fileSlug}), {title} (slugified frontmatter \
title), {year} {month} {day} (from frontmatter date or filename), {dir} (folders between the route folder and the \
file), {fm.KEY} (any top-level frontmatter field of the post, e.g. {fm.category}), and the groups of the route's \
capture. Any token can pass through filters, left to right, each after a '|': number (the first run of digits with \
leading zeros dropped, 0007 becomes 7, as JavaScript's parseInt does), lower, upper, slugify, strip-date (a leading \
YYYY-MM-DD- removed), replace:FROM:TO (literal; TO may be empty; neither may contain ':', '|' or '}'). Examples: an \
Eleventy folder data file with permalink \"/blog/{{ page.fileSlug }}/\" is \"/blog/{fileSlug}/\"; a permalink \
function returning `/photo/${parseInt(data.page.fileSlug.match(/(\\d+)/)[1])}/` is \"/photo/{stem|number}/\".\n\
capture: a regular expression (Rust regex syntax: no lookaround, no backreferences) matched against the file's path \
inside the folder without its extension. Its named groups (?<name>...) become tokens {name}, unnamed ones {1}, {2}. \
A file it does not match gets no URL from that route, so two routes for one folder can divide it. Use \"\" when \
tokens and filters are enough, which is most of the time. A post whose pattern cannot be filled (a frontmatter field \
it lacks, a number filter on text with no digits) gets no URL rather than a wrong one.\n\
\n\
Your routes are tried on the live site: a few posts per folder are fetched at the URLs your patterns give them, and \
each page is checked for the post's text. When URLs the live site serves are listed, the URLs your routes give should \
look like them. Every folder and repoPath must be repository-relative and must appear in the listing. urlPrefix \
values start and end with '/'. repoPath values end with '/' unless they are the repository root, written as an \
empty string. Prefer what the config and code state over convention. A starting guess made by simple rules is \
included, with what the live site said about it when it could be asked; correct it where it is wrong. Put anything \
uncertain, briefly, in notes.";

/// The live site, for trying an answer on: where it is, and which files it
/// cannot have yet (changed here, or in commits GitHub does not have).
pub struct Live<'a> {
    pub site: &'a livecheck::Site,
    pub unpublished: &'a HashSet<String>,
}

/// Ask the model for a site profile, starting from the rule-based one.
///
/// With the live site to hand, the answer's routes are tried there; when
/// some posts are not where the answer puts them, the model is shown what
/// the site said and asked once more. The answer that found more posts is
/// kept — or the rule-based routes, if they found more than either — with
/// its checks, so the person can see what was confirmed.
pub fn detect_site(root: &Path, heuristic: &SiteProfile, folders: &[String], live: Option<Live>) -> Result<SiteProfile, String> {
    let schema = profile_schema();
    detect_site_with(root, heuristic, folders, live, &|turns| complete_json_turns(SYSTEM, turns, &schema))
}

/// `detect_site`, with the provider call handed in, so the rounds can be
/// tested against a scripted model.
fn detect_site_with(root: &Path, heuristic: &SiteProfile, folders: &[String], live: Option<Live>, ask: &dyn Fn(&[Turn]) -> Result<Value, String>) -> Result<SiteProfile, String> {
    let content_folders: Vec<String> = if folders.is_empty() { heuristic.suggested_folders.iter().take(4).cloned().collect() } else { folders.to_vec() };
    let mut seen = LiveContext::default();
    let mut rule_checks = Vec::new();
    if let Some(l) = &live {
        crate::events::info("ai", "Trying the rule-based routes on the live site and collecting the URLs it serves");
        rule_checks = livecheck::check(root, heuristic, l.site, &content_folders, l.unpublished);
        seen = LiveContext { public_url: format!("{}{}/", l.site.origin, l.site.base), urls: livecheck::site_urls(l.site, 60), checks: rule_checks.clone() };
    }
    let user = context(root, heuristic, folders, &seen);
    crate::events::debug("ai", format!("Sending the file listing, config and routing files, sample posts and live URLs ({} characters)", user.len()));

    let mut turns = vec![Turn::user(user)];
    let mut best: Option<(i64, SiteProfile)> = None;
    for round in 0..2 {
        let answer = match ask(&turns) {
            Ok(a) => a,
            // A failed second round leaves the first answer standing.
            Err(e) if best.is_some() => {
                crate::events::warn("ai", format!("The second answer did not arrive ({e}); keeping the first"));
                break;
            }
            Err(e) => return Err(e),
        };
        let mut profile = match read_answer(root, heuristic, &answer) {
            Ok(p) => p,
            Err(e) if best.is_some() => {
                crate::events::warn("ai", format!("The second answer could not be used ({e}); keeping the first"));
                break;
            }
            Err(e) => return Err(e),
        };
        let Some(l) = &live else { return Ok(profile) };
        profile.checks = livecheck::check(root, &profile, l.site, &content_folders, l.unpublished);
        profile.checked_at = crate::store::now_ms();
        for c in &profile.checks {
            crate::events::info("ai", format!("{} → {}: {}", c.folder, c.pattern, c.message));
        }
        let points = score(&profile.checks);
        if best.as_ref().is_none_or(|(b, _)| points >= *b) {
            best = Some((points, profile.clone()));
        }
        let settled = profile.checks.iter().all(|c| c.outcome == "ok" || c.outcome == "unchecked");
        if settled || round == 1 {
            break;
        }
        crate::events::info("ai", "Some posts are not where that answer puts them; showing the model what the live site said");
        turns.push(Turn::assistant(answer.to_string()));
        turns.push(Turn::user(feedback(&profile, &seen.public_url)));
    }
    let (points, mut profile) = best.ok_or("The model gave no answer.")?;
    if !rule_checks.is_empty() && score(&rule_checks) > points {
        profile.routes = heuristic.routes.clone();
        profile.checks = rule_checks;
        profile.notes = format!("The model's routes found fewer posts on the live site than the rule-based ones, so those were kept.\n{}", profile.notes).trim().to_string();
    }
    Ok(profile)
}

/// A model's answer as a profile this app can trust: sanitised, and refused
/// if nothing in it exists here.
fn read_answer(root: &Path, heuristic: &SiteProfile, answer: &Value) -> Result<SiteProfile, String> {
    let mut profile: SiteProfile = serde_json::from_value(answer.clone()).map_err(|e| format!("The model's site profile did not fit: {e}"))?;
    profile.source = "ai".into();
    profile.public_url_hint = heuristic.public_url_hint.clone();
    profile.checks.clear();
    profile.checked_at = 0;
    let profile = site::sanitize(root, profile);
    if profile.routes.is_empty() && profile.assets.is_empty() {
        return Err("The model's answer named no folders that exist here; the rule-based profile was kept.".into());
    }
    Ok(profile)
}

/// How well a profile's routes did: a confirmed folder far outweighs a few
/// found posts, so one good folder beats two half-right ones.
fn score(checks: &[site::RouteCheck]) -> i64 {
    checks
        .iter()
        .map(|c| {
            let found = c.samples.iter().filter(|s| s.outcome == "found" || s.outcome == "reachable").count() as i64;
            found + match c.outcome.as_str() {
                "ok" => 100,
                "mixed" => 40,
                _ => 0,
            }
        })
        .sum()
}

/// What the live site said about an answer, for the model's second try.
fn feedback(profile: &SiteProfile, public_url: &str) -> String {
    let mut out = format!("I tried the routes from your answer on the live site, {public_url}:\n\n");
    for c in &profile.checks {
        out.push_str(&check_lines(c));
    }
    let dropped: Vec<&str> = profile.notes.lines().filter(|l| l.contains("was left out")).collect();
    if !dropped.is_empty() {
        out.push_str("\nSome routes could not be used at all:\n");
        for line in dropped {
            out.push_str(&format!("- {line}\n"));
        }
    }
    out.push_str(
        "\nWork out where the site really publishes these posts — from the routing code and the URLs it serves listed \
earlier — and answer with the whole profile again, with the routes corrected. Keep the routes that were found.",
    );
    out
}

fn check_lines(c: &site::RouteCheck) -> String {
    let route = if c.pattern.is_empty() { "no route".to_string() } else if c.capture.is_empty() { format!("`{}`", c.pattern) } else { format!("`{}` (capture `{}`)", c.pattern, c.capture) };
    let mut out = format!("- {} → {route}: {} ({})\n", c.folder, c.outcome, c.message);
    for s in &c.samples {
        out.push_str(&format!("  - {} → {}: {}\n", s.path, s.url, livecheck::describe(s)));
    }
    out
}

/// What the model is told about the live site.
#[derive(Default)]
pub struct LiveContext {
    pub public_url: String,
    pub urls: Vec<String>,
    pub checks: Vec<site::RouteCheck>,
}

const CONFIG_FILES: &[&str] = &[
    ".eleventy.js", "eleventy.config.js", "eleventy.config.mjs", "eleventy.config.cjs", ".eleventy.cjs",
    "_config.yml", "_config.yaml", "hugo.toml", "hugo.yaml", "hugo.json", "config.toml", "config.yaml",
    "astro.config.mjs", "astro.config.ts", "astro.config.js", "gatsby-config.js", "gatsby-config.ts",
    "gatsby-node.js", "gatsby-node.ts", "gatsby-node.mjs",
    "next.config.js", "next.config.mjs", "svelte.config.js", "docusaurus.config.js", "mkdocs.yml",
    "package.json", "Gemfile", "netlify.toml", "vercel.json", "_redirects", "CNAME", "public/CNAME", "static/CNAME",
];

/// What the model is shown: a listing, the config, the code that decides
/// URLs, a few posts, the live site's URLs, and the guess with how it did.
pub fn context(root: &Path, heuristic: &SiteProfile, folders: &[String], live: &LiveContext) -> String {
    let mut out = String::from("## Repository listing\n\n");
    listing(root, 0, &mut out, &mut 0);

    out.push_str("\n## Config files\n");
    let mut budget = 60_000usize;
    let mut included: HashSet<String> = HashSet::new();
    let mut include = |rel: &str, out: &mut String, limit: usize| {
        if included.contains(rel) || budget == 0 {
            return;
        }
        if let Ok(text) = std::fs::read_to_string(root.join(rel)) {
            let cut: String = text.chars().take(limit.min(budget)).collect();
            budget = budget.saturating_sub(cut.len());
            included.insert(rel.to_string());
            out.push_str(&format!("\n### {rel}\n```\n{cut}\n```\n"));
        }
    };
    for rel in CONFIG_FILES {
        include(rel, &mut out, 8_000);
    }
    if let Ok(entries) = std::fs::read_dir(root.join(".github/workflows")) {
        for entry in entries.flatten().take(3) {
            let rel = format!(".github/workflows/{}", entry.file_name().to_string_lossy());
            include(&rel, &mut out, 8_000);
        }
    }
    let content_folders: Vec<String> = if folders.is_empty() { heuristic.suggested_folders.clone() } else { folders.to_vec() };
    for folder in content_folders.iter().take(4) {
        if let Ok(entries) = std::fs::read_dir(root.join(folder)) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.ends_with(".json") || name.contains(".11tydata.") || name == "_index.md" || name == "_metadata.yml" {
                    include(&format!("{folder}/{name}"), &mut out, 8_000);
                }
            }
        }
    }

    let routing = routing_files(root);
    if !routing.is_empty() {
        out.push_str("\n## Files that look like they decide URLs\n");
        for rel in routing {
            include(&rel, &mut out, 6_000);
        }
    }

    out.push_str("\n## Sample posts (first lines)\n");
    for folder in content_folders.iter().take(3) {
        let Ok(entries) = std::fs::read_dir(root.join(folder)) else { continue };
        let mut names: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| site::is_markdown(n)).collect();
        names.sort();
        let picks: Vec<&String> = names.iter().rev().take(2).collect();
        for name in picks {
            if let Ok(text) = std::fs::read_to_string(root.join(folder).join(name)) {
                let head: String = text.lines().take(40).collect::<Vec<_>>().join("\n");
                out.push_str(&format!("\n### {folder}/{name}\n```\n{head}\n```\n"));
            }
        }
    }

    if !live.public_url.is_empty() {
        out.push_str(&format!("\n## The live site\n\nPublished at {}.\n", live.public_url));
        if live.urls.is_empty() {
            out.push_str("\nNo sitemap, and no links could be read from its home page.\n");
        } else {
            out.push_str("\nURLs it serves, from its sitemap or home page:\n\n");
            for u in &live.urls {
                out.push_str(&format!("{u}\n"));
            }
        }
    }

    let mut guess = heuristic.clone();
    guess.checks.clear();
    out.push_str("\n## Rule-based guess\n```json\n");
    out.push_str(&serde_json::to_string_pretty(&guess).unwrap_or_default());
    out.push_str("\n```\n");
    if !live.checks.is_empty() {
        out.push_str("\nIts routes, tried on the live site:\n\n");
        for c in &live.checks {
            out.push_str(&check_lines(c));
        }
    }
    out
}

const ROUTING_EXTENSIONS: &[&str] = &["js", "mjs", "cjs", "ts", "jsx", "tsx", "astro", "njk", "liquid", "html", "svelte", "vue", "md", "yml", "yaml", "toml", "json"];
const ROUTING_WORDS: &[&str] = &["permalink", "getStaticPaths", "generateStaticParams", "createPage(", "eleventyComputed", "addCollection", "permalinks"];

/// Source files outside the config that decide URLs: route files named with
/// brackets (`[slug].astro`, `[...path].js`), and templates or scripts that
/// mention a permalink, a collection or a page generator. At most eight,
/// route files first.
fn routing_files(root: &Path) -> Vec<String> {
    let mut named = Vec::new();
    let mut mention = Vec::new();
    let mut seen = 0usize;
    walk_routing(root, root, 0, &mut seen, &mut named, &mut mention);
    named.sort();
    mention.sort();
    named.into_iter().chain(mention).take(8).collect()
}

fn walk_routing(root: &Path, dir: &Path, depth: usize, seen: &mut usize, named: &mut Vec<String>, mention: &mut Vec<String>) {
    if depth > 5 || *seen > 3000 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        *seen += 1;
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            if !["node_modules", "_site", "dist", "build", "out", "vendor", "public", "static", "resources", "target"].contains(&name.as_str()) {
                walk_routing(root, &path, depth + 1, seen, named, mention);
            }
            continue;
        }
        let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
        if !ROUTING_EXTENSIONS.contains(&ext.as_str()) || name.contains(".min.") || name.ends_with("lock.json") {
            continue;
        }
        let rel = crate::store::rel_string(root, &path);
        if name.contains('[') && name.contains(']') {
            named.push(rel);
            continue;
        }
        // Posts themselves mention permalinks in their frontmatter; only the
        // first lines of a template or script are worth reading for this.
        if ext == "md" && !rel.contains("_includes") && !rel.contains("layouts") {
            continue;
        }
        let small = entry.metadata().map(|m| m.len() < 200_000).unwrap_or(false);
        if small && CONFIG_FILES.iter().all(|c| *c != rel) {
            if let Ok(text) = std::fs::read_to_string(&path) {
                if ROUTING_WORDS.iter().any(|w| text.contains(w)) {
                    mention.push(rel);
                }
            }
        }
    }
}

fn listing(dir: &Path, depth: usize, out: &mut String, lines: &mut usize) {
    if depth > 4 || *lines > 600 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".git" || name == "node_modules" || name == "_site" || name == ".DS_Store" {
            continue;
        }
        if entry.path().is_dir() {
            dirs.push(name);
        } else {
            files.push(name);
        }
    }
    dirs.sort();
    files.sort();
    let indent = "  ".repeat(depth);
    let shown = 8;
    for name in files.iter().take(shown) {
        out.push_str(&format!("{indent}{name}\n"));
        *lines += 1;
    }
    if files.len() > shown {
        let md = files.iter().filter(|f| site::is_markdown(f)).count();
        out.push_str(&format!("{indent}… {} more files ({md} markdown in this folder)\n", files.len() - shown));
        *lines += 1;
    }
    for name in dirs {
        out.push_str(&format!("{indent}{name}/\n"));
        *lines += 1;
        listing(&dir.join(&name), depth + 1, out, lines);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_model_list_is_filtered_to_text_models() {
        assert!(is_openai_text_model("gpt-6.2-sol"));
        assert!(is_openai_text_model("o4-mini"));
        assert!(!is_openai_text_model("gpt-realtime-2.1-mini"));
        assert!(!is_openai_text_model("text-embedding-3-large"));
        assert!(!is_openai_text_model("dall-e-3"));
    }

    #[test]
    fn request_options_follow_the_model() {
        assert!(supports_fallbacks("claude-opus-5-5"));
        assert!(!supports_fallbacks("claude-haiku-5-5"));
        assert!(supports_effort("claude-opus-5-5"));
        assert!(!supports_effort("claude-haiku-4-5"));
    }

    #[test]
    fn the_schema_is_strict_everywhere() {
        fn check(v: &Value) {
            if v.get("type").and_then(|t| t.as_str()) == Some("object") {
                assert_eq!(v.get("additionalProperties"), Some(&json!(false)));
                let props: Vec<&String> = v["properties"].as_object().unwrap().keys().collect();
                let required: Vec<&str> = v["required"].as_array().unwrap().iter().map(|r| r.as_str().unwrap()).collect();
                for p in props {
                    assert!(required.contains(&p.as_str()), "{p} not required");
                }
                for child in v["properties"].as_object().unwrap().values() {
                    check(child);
                }
            }
            if let Some(items) = v.get("items") {
                check(items);
            }
        }
        check(&profile_schema());
    }

    #[test]
    fn anthropic_replies_are_read_from_text_blocks_only() {
        let ok = json!({
            "stop_reason": "end_turn",
            "content": [
                { "type": "thinking", "thinking": "" },
                { "type": "text", "text": "{\"generator\": " },
                { "type": "text", "text": "\"eleventy\"}" }
            ]
        });
        assert_eq!(parse_anthropic(&ok).unwrap(), json!({ "generator": "eleventy" }));
        let refused = json!({ "stop_reason": "refusal", "content": [] });
        assert!(parse_anthropic(&refused).unwrap_err().contains("declined"));
        let cut = json!({ "stop_reason": "max_tokens", "content": [{ "type": "text", "text": "{" }] });
        assert!(parse_anthropic(&cut).unwrap_err().contains("cut off"));
    }

    #[test]
    fn openai_replies_are_read_from_output_text() {
        let ok = json!({
            "status": "completed",
            "output": [
                { "type": "reasoning", "summary": [] },
                { "type": "message", "content": [{ "type": "output_text", "text": "{\"generator\":\"hugo\"}" }] }
            ]
        });
        assert_eq!(parse_openai(&ok).unwrap(), json!({ "generator": "hugo" }));
        let refused = json!({ "status": "completed", "output": [{ "type": "message", "content": [{ "type": "refusal", "refusal": "no" }] }] });
        assert!(parse_openai(&refused).unwrap_err().contains("declined"));
        assert!(parse_openai(&json!({ "status": "incomplete", "output": [] })).unwrap_err().contains("cut off"));
    }

    /// A stand-in for dripdrip.natelaffan.com on a local port: `/photo/N/`
    /// shows photo N's caption, anything else is a 404.
    fn photo_site(captions: Vec<(u32, &'static str)>) -> String {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let captions = captions.clone();
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    let path = line.split_whitespace().nth(1).unwrap_or("/").to_string();
                    loop {
                        let mut h = String::new();
                        if reader.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
                            break;
                        }
                    }
                    let n: Option<u32> = path.strip_prefix("/photo/").and_then(|r| r.trim_end_matches('/').parse().ok()).filter(|_| !path.contains("/photo/0"));
                    let body = n.and_then(|n| captions.iter().find(|(c, _)| *c == n)).map(|(n, c)| format!("<html><body><span>{n}</span><p>{c}</p></body></html>"));
                    let (status, body) = match (path.as_str(), body) {
                        ("/", _) => ("200 OK", r#"<meta http-equiv="refresh" content="0; url=/photo/3/">"#.to_string()),
                        (_, Some(b)) => ("200 OK", b),
                        _ => ("404 Not Found", "not here".to_string()),
                    };
                    let mut out = stream;
                    let _ = write!(out, "HTTP/1.1 {status}\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                });
            }
        });
        format!("http://{addr}/")
    }

    #[test]
    fn a_wrong_first_answer_is_corrected_from_what_the_site_said() {
        let root = std::env::temp_dir().join(format!("gitidor-ai-loop-{}-{}", std::process::id(), crate::store::new_id()));
        std::fs::create_dir_all(root.join("content/photos")).unwrap();
        let captions = vec![(1, "Twin stripes across the Wyoming sky."), (2, "A minivan with stickers outside Kimball, Nebraska."), (3, "Fog over the harbour at dawn, again.")];
        for (n, c) in &captions {
            std::fs::write(root.join(format!("content/photos/{n:04}.md")), format!("---\nfilename: {n}.jpg\n---\n{c}\n")).unwrap();
        }
        let url = photo_site(captions);
        let site = livecheck::Site::from_public_url(&url).unwrap();
        let unpublished = HashSet::new();
        let heuristic = site::detect(&root);

        let calls = std::cell::RefCell::new(Vec::<Vec<Turn>>::new());
        let answer = |pattern: &str| json!({
            "generator": "eleventy", "routes": [{ "folder": "content/photos", "pattern": pattern, "capture": "" }],
            "assets": [], "stylesheets": [], "suggestedFolders": ["content/photos"], "notes": ""
        });
        let ask = |turns: &[Turn]| -> Result<Value, String> {
            calls.borrow_mut().push(turns.to_vec());
            Ok(if turns.len() == 1 { answer("/photo/{stem}/") } else { answer("/photo/{stem|number}/") })
        };
        let p = detect_site_with(&root, &heuristic, &["content/photos".into()], Some(Live { site: &site, unpublished: &unpublished }), &ask).unwrap();

        let calls = calls.into_inner();
        assert_eq!(calls.len(), 2);
        // The first question shows the live site's URLs and how the rules did.
        assert!(calls[0][0].text.contains("/photo/3/"), "live URLs missing");
        assert!(calls[0][0].text.contains("/content/photos/0001/: the site has no page there (404)"));
        // The second is the model's answer and what the site said about it.
        assert_eq!(calls[1][1].role, "assistant");
        assert!(calls[1][2].text.contains("/photo/0001/: the site has no page there (404)"), "{}", calls[1][2].text);
        assert_eq!(p.routes[0].pattern, "/photo/{stem|number}/");
        assert_eq!(p.checks[0].outcome, "ok");
        assert_eq!(p.source, "ai");
    }

    #[test]
    fn a_right_first_answer_is_not_asked_again() {
        let root = std::env::temp_dir().join(format!("gitidor-ai-once-{}-{}", std::process::id(), crate::store::new_id()));
        std::fs::create_dir_all(root.join("content/photos")).unwrap();
        std::fs::write(root.join("content/photos/0001.md"), "---\nx: 1\n---\nTwin stripes across the Wyoming sky.\n").unwrap();
        let url = photo_site(vec![(1, "Twin stripes across the Wyoming sky.")]);
        let site = livecheck::Site::from_public_url(&url).unwrap();
        let unpublished = HashSet::new();
        let count = std::cell::Cell::new(0);
        let ask = |_: &[Turn]| -> Result<Value, String> {
            count.set(count.get() + 1);
            Ok(json!({ "generator": "eleventy", "routes": [{ "folder": "content/photos", "pattern": "/photo/{stem|number}/", "capture": "" }], "assets": [], "stylesheets": [], "suggestedFolders": [], "notes": "" }))
        };
        let p = detect_site_with(&root, &site::detect(&root), &["content/photos".into()], Some(Live { site: &site, unpublished: &unpublished }), &ask).unwrap();
        assert_eq!(count.get(), 1);
        assert_eq!(p.checks[0].outcome, "ok");
    }

    /// What would be sent for a real checkout, live site included:
    /// `GITIDOR_SITE=/path/to/checkout cargo test print_the_context -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn print_the_context_for_a_real_checkout() {
        let root = std::path::PathBuf::from(std::env::var("GITIDOR_SITE").expect("set GITIDOR_SITE"));
        let h = site::detect(&root);
        let mut live = LiveContext::default();
        if let Some(s) = livecheck::Site::from_public_url(&h.public_url_hint) {
            let folders = h.suggested_folders.iter().take(4).cloned().collect::<Vec<_>>();
            live = LiveContext { public_url: format!("{}{}/", s.origin, s.base), urls: livecheck::site_urls(&s, 60), checks: livecheck::check(&root, &h, &s, &folders, &HashSet::new()) };
        }
        println!("{SYSTEM}\n\n---\n\n{}", context(&root, &h, &[], &live));
    }

    #[test]
    fn the_context_includes_config_and_samples() {
        let root = std::env::temp_dir().join(format!("gitidor-ai-{}-{}", std::process::id(), crate::store::new_id()));
        std::fs::create_dir_all(root.join("posts")).unwrap();
        std::fs::write(root.join(".eleventy.js"), "addPassthroughCopy({ \"public/blog-images\": \"images/blog\" })").unwrap();
        std::fs::write(root.join("posts/posts.json"), "{\"permalink\": \"/blog/{{ page.fileSlug }}/\"}").unwrap();
        std::fs::write(root.join("posts/2010-03-14--crickets.md"), "---\ntitle: Crickets\n---\n").unwrap();
        let h = site::detect(&root);
        let text = context(&root, &h, &["posts".into()], &LiveContext::default());
        assert!(text.contains("### .eleventy.js"));
        assert!(text.contains("### posts/posts.json"));
        assert!(text.contains("### posts/2010-03-14--crickets.md"));
        assert!(text.contains("## Rule-based guess"));
    }
}
