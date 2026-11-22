//! Everything a person can change in the Settings sheet that is not a secret.
//!
//! Every field has a serde default, so a file written by an older build reads
//! cleanly into a newer one and a field this build does not know is dropped
//! rather than failing the whole read.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Appearance {
    /// `system`, `light` or `dark`.
    pub theme: String,
    /// A key from the font list in `src/lib/fonts.ts`, or `custom`.
    pub font: String,
    /// A CSS font-family, used when `font` is `custom`.
    pub custom_font: String,
    pub font_size: u32,
    pub line_height: f32,
    /// The text column's maximum width, in characters.
    pub column_width: u32,
    /// `dim` (visible, quiet), `fold` (collapsed to one line) or `show`.
    pub frontmatter: String,
    pub inline_images: bool,
    pub spellcheck: bool,
}

impl Default for Appearance {
    fn default() -> Self {
        Appearance {
            theme: "system".into(),
            font: "plex-mono".into(),
            custom_font: String::new(),
            font_size: 17,
            line_height: 1.65,
            column_width: 66,
            frontmatter: "dim".into(),
            inline_images: true,
            spellcheck: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GitSettings {
    /// Commit author. Empty means the GitHub login and its no-reply address.
    pub author_name: String,
    pub author_email: String,
    /// `{files}` is replaced with the changed file names.
    pub commit_template: String,
    /// Fetch (never merge) when a repository is opened, if the network is there.
    pub fetch_on_open: bool,
    /// Push straight after committing, rather than leaving it for later.
    pub push_after_commit: bool,
}

impl Default for GitSettings {
    fn default() -> Self {
        GitSettings {
            author_name: String::new(),
            author_email: String::new(),
            commit_template: "Update {files}".into(),
            fetch_on_open: true,
            push_after_commit: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiSettings {
    /// `anthropic`, `openai` or `none`.
    pub provider: String,
    pub anthropic_model: String,
    pub openai_model: String,
}

impl Default for AiSettings {
    fn default() -> Self {
        AiSettings {
            provider: "none".into(),
            anthropic_model: crate::ai::DEFAULT_ANTHROPIC_MODEL.into(),
            // Filled from the account's own model list the first time a key
            // is tested — OpenAI's names move too often to pin one here.
            openai_model: String::new(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub appearance: Appearance,
    pub git: GitSettings,
    pub ai: AiSettings,
    /// Editor autosave delay in milliseconds.
    pub autosave_ms: u32,
}

const FILE: &str = "settings.json";

pub fn load() -> Result<Settings, String> {
    let mut settings: Settings = crate::store::read_json(FILE)?;
    if settings.autosave_ms == 0 {
        settings.autosave_ms = 800;
    }
    Ok(settings)
}

pub fn save(settings: &Settings) -> Result<(), String> {
    crate::store::write_json(FILE, settings, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_partial_file_fills_in_defaults() {
        let parsed: Settings = serde_json::from_str(r#"{"appearance":{"fontSize":20}}"#).unwrap();
        assert_eq!(parsed.appearance.font_size, 20);
        assert_eq!(parsed.appearance.theme, "system");
        assert!(parsed.git.push_after_commit);
        assert_eq!(parsed.ai.provider, "none");
    }
}
