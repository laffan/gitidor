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
use crate::site::{self, SiteProfile};
use serde::Serialize;
use serde_json::{json, Value};
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

/// Ask the configured provider for JSON matching `schema`.
pub fn complete_json(system: &str, user: &str, schema: &Value) -> Result<Value, String> {
    let settings = crate::settings::load().unwrap_or_default();
    match settings.ai.provider.as_str() {
        "anthropic" => {
            let model = if settings.ai.anthropic_model.is_empty() { DEFAULT_ANTHROPIC_MODEL.to_string() } else { settings.ai.anthropic_model };
            anthropic(&key_for("anthropic")?, &model, system, user, schema)
        }
        "openai" => {
            if settings.ai.openai_model.is_empty() {
                return Err("Choose an OpenAI model under Settings → AI (press Test to load the list).".into());
            }
            openai(&key_for("openai")?, &settings.ai.openai_model, system, user, schema)
        }
        _ => Err("No AI provider is set up. Choose one under Settings → AI.".into()),
    }
}

fn anthropic(key: &str, model: &str, system: &str, user: &str, schema: &Value) -> Result<Value, String> {
    let mut output_config = json!({ "format": { "type": "json_schema", "schema": schema } });
    if supports_effort(model) {
        // A structured read of config files, not a hard reasoning problem.
        output_config["effort"] = json!("medium");
    }
    let mut body = json!({
        "model": model,
        "max_tokens": 16000,
        "system": system,
        "messages": [{ "role": "user", "content": user }],
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

fn openai(key: &str, model: &str, system: &str, user: &str, schema: &Value) -> Result<Value, String> {
    let body = json!({
        "model": model,
        "input": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
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
                "type": "object", "additionalProperties": false, "required": ["folder", "pattern"],
                "properties": { "folder": string, "pattern": string }
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

const SYSTEM: &str = "You are helping a markdown editor understand a static website's source repository so it can \
preview posts accurately. From the repository listing, config files and sample posts you are given, work out:\n\
1. routes: for each folder of markdown posts, the URL pattern the generator publishes a post at.\n\
2. assets: how site URL prefixes (as written in posts, e.g. /images/blog/) map to folders in the repository \
(e.g. public/blog-images/). Include a catch-all '/' entry for the folder the site root is copied from.\n\
3. stylesheets: repository paths of the site's main CSS files, if any are plain .css.\n\
4. suggestedFolders: the folders that hold posts a person would edit, most important first.\n\
\n\
URL patterns use these tokens and nothing else: {path} (path inside the folder without extension, /index dropped), \
{stem} (last segment of {path}), {fileSlug} ({stem} with a leading YYYY-MM-DD- removed, exactly one hyphen with it, \
as Eleventy's page.fileSlug and Jekyll's :title do), {slug} (frontmatter slug, else {fileSlug}), {title} \
(slugified frontmatter title), {year} {month} {day} (from frontmatter date or filename), {dir} (folders between the \
route folder and the file). Example: an Eleventy folder data file with permalink \"/blog/{{ page.fileSlug }}/\" is \
the pattern \"/blog/{fileSlug}/\".\n\
\n\
Every folder and repoPath must be repository-relative and must appear in the listing. urlPrefix values start and \
end with '/'. repoPath values end with '/' unless they are the repository root, written as an empty string. \
Prefer what the config files state over convention. A starting guess made by simple rules is included; correct it \
where the config says otherwise. Put anything uncertain, briefly, in notes.";

/// Ask the model for a site profile, starting from the rule-based one.
pub fn detect_site(root: &Path, heuristic: &SiteProfile, folders: &[String]) -> Result<SiteProfile, String> {
    let user = context(root, heuristic, folders);
    crate::events::debug("ai", format!("Sending the file listing, config files and sample posts ({} characters)", user.len()));
    let answer = complete_json(SYSTEM, &user, &profile_schema())?;
    let mut profile: SiteProfile = serde_json::from_value(answer).map_err(|e| format!("The model's site profile did not fit: {e}"))?;
    profile.source = "ai".into();
    profile.public_url_hint = heuristic.public_url_hint.clone();
    let profile = site::sanitize(root, profile);
    if profile.routes.is_empty() && profile.assets.is_empty() {
        return Err("The model's answer named no folders that exist here; the rule-based profile was kept.".into());
    }
    Ok(profile)
}

const CONFIG_FILES: &[&str] = &[
    ".eleventy.js", "eleventy.config.js", "eleventy.config.mjs", "eleventy.config.cjs", ".eleventy.cjs",
    "_config.yml", "_config.yaml", "hugo.toml", "hugo.yaml", "hugo.json", "config.toml", "config.yaml",
    "astro.config.mjs", "astro.config.ts", "astro.config.js", "gatsby-config.js", "gatsby-config.ts",
    "next.config.js", "next.config.mjs", "svelte.config.js", "docusaurus.config.js", "mkdocs.yml",
    "package.json", "Gemfile", "netlify.toml", "vercel.json", "CNAME", "public/CNAME", "static/CNAME",
];

/// What the model is shown: a listing, the config, a few posts, the guess.
pub fn context(root: &Path, heuristic: &SiteProfile, folders: &[String]) -> String {
    let mut out = String::from("## Repository listing\n\n");
    listing(root, 0, &mut out, &mut 0);

    out.push_str("\n## Config files\n");
    let mut budget = 60_000usize;
    let mut include = |rel: &str, out: &mut String| {
        if let Ok(text) = std::fs::read_to_string(root.join(rel)) {
            let cut: String = text.chars().take(8_000.min(budget)).collect();
            budget = budget.saturating_sub(cut.len());
            out.push_str(&format!("\n### {rel}\n```\n{cut}\n```\n"));
        }
    };
    for rel in CONFIG_FILES {
        include(rel, &mut out);
    }
    if let Ok(entries) = std::fs::read_dir(root.join(".github/workflows")) {
        for entry in entries.flatten().take(3) {
            let rel = format!(".github/workflows/{}", entry.file_name().to_string_lossy());
            include(&rel, &mut out);
        }
    }
    let content_folders: Vec<String> = if folders.is_empty() { heuristic.suggested_folders.clone() } else { folders.to_vec() };
    for folder in content_folders.iter().take(4) {
        if let Ok(entries) = std::fs::read_dir(root.join(folder)) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.ends_with(".json") || name.contains(".11tydata.") || name == "_index.md" || name == "_metadata.yml" {
                    include(&format!("{folder}/{name}"), &mut out);
                }
            }
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

    out.push_str("\n## Rule-based guess\n```json\n");
    out.push_str(&serde_json::to_string_pretty(heuristic).unwrap_or_default());
    out.push_str("\n```\n");
    out
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

    #[test]
    fn the_context_includes_config_and_samples() {
        let root = std::env::temp_dir().join(format!("gitidor-ai-{}-{}", std::process::id(), crate::store::new_id()));
        std::fs::create_dir_all(root.join("posts")).unwrap();
        std::fs::write(root.join(".eleventy.js"), "addPassthroughCopy({ \"public/blog-images\": \"images/blog\" })").unwrap();
        std::fs::write(root.join("posts/posts.json"), "{\"permalink\": \"/blog/{{ page.fileSlug }}/\"}").unwrap();
        std::fs::write(root.join("posts/2010-03-14--crickets.md"), "---\ntitle: Crickets\n---\n").unwrap();
        let h = site::detect(&root);
        let text = context(&root, &h, &["posts".into()]);
        assert!(text.contains("### .eleventy.js"));
        assert!(text.contains("### posts/posts.json"));
        assert!(text.contains("### posts/2010-03-14--crickets.md"));
        assert!(text.contains("## Rule-based guess"));
    }
}
