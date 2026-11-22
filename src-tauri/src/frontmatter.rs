//! Just enough frontmatter to list a folder and work out a post's URL.
//!
//! The editor parses frontmatter properly in the webview (`yaml` and
//! `smol-toml`); this side needs only the handful of top-level scalar fields
//! that decide what a file is called and where it is published — `title`,
//! `date`, `slug`, `permalink`, `url`, `draft` — for every file in a folder at
//! once, without shipping each file's text across IPC. So it reads top-level
//! `key: value` (YAML, between `---`) and `key = value` (TOML, between `+++`)
//! lines and leaves everything nested alone.

use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Yaml,
    Toml,
}

#[derive(Debug, Clone, Default)]
pub struct Front {
    /// Which fence opened it. Read by tests; kept for callers that will want
    /// to write frontmatter back in the same format.
    #[allow(dead_code)]
    pub format: Option<Format>,
    pub fields: BTreeMap<String, String>,
}

impl Front {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.fields.get(key).map(String::as_str).filter(|v| !v.is_empty())
    }

    /// `(year, month, day)` from the `date` field, if it starts with one.
    pub fn date(&self) -> Option<(String, String, String)> {
        self.get("date").and_then(ymd_prefix)
    }

    pub fn is_draft(&self) -> bool {
        matches!(self.get("draft"), Some("true") | Some("yes"))
            || matches!(self.get("published"), Some("false") | Some("no"))
            || matches!(self.get("private"), Some("true") | Some("yes"))
    }
}

pub fn parse(text: &str) -> Front {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.lines();
    let (format, fence) = match lines.next().map(str::trim_end) {
        Some("---") => (Format::Yaml, "---"),
        Some("+++") => (Format::Toml, "+++"),
        _ => return Front::default(),
    };
    let mut fields = BTreeMap::new();
    let mut closed = false;
    for line in lines {
        let trimmed = line.trim_end();
        if trimmed == fence || (format == Format::Yaml && trimmed == "...") {
            closed = true;
            break;
        }
        // Top level only: an indented line belongs to something nested.
        if line.starts_with([' ', '\t']) || line.starts_with('#') {
            continue;
        }
        let split = match format {
            Format::Yaml => line.split_once(':'),
            Format::Toml => line.split_once('='),
        };
        let Some((key, value)) = split else { continue };
        let key = key.trim();
        if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            continue;
        }
        fields.insert(key.to_ascii_lowercase(), scalar(value));
    }
    if !closed {
        return Front::default();
    }
    Front { format: Some(format), fields }
}

/// A scalar with its quotes and any trailing comment taken off. Lists, maps
/// and block scalars come back empty: none of the fields read here are those.
fn scalar(raw: &str) -> String {
    let value = raw.trim();
    if value.starts_with('[') || value.starts_with('{') || value == "|" || value == ">" || value.is_empty() {
        return String::new();
    }
    for quote in ['"', '\''] {
        if let Some(inner) = value.strip_prefix(quote) {
            if let Some(end) = inner.find(quote) {
                return inner[..end].to_string();
            }
        }
    }
    let value = match value.find(" #") {
        Some(i) => &value[..i],
        None => value,
    };
    value.trim().to_string()
}

/// `YYYY-MM-DD` at the start of a string.
pub fn ymd_prefix(text: &str) -> Option<(String, String, String)> {
    let bytes = text.as_bytes();
    if bytes.len() < 10 {
        return None;
    }
    let digits = |r: std::ops::Range<usize>| bytes[r].iter().all(u8::is_ascii_digit);
    if digits(0..4) && bytes[4] == b'-' && digits(5..7) && bytes[7] == b'-' && digits(8..10) {
        Some((text[0..4].into(), text[5..7].into(), text[8..10].into()))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn yaml_frontmatter_top_level_scalars() {
        let f = parse("---\ntitle: Crickets\ndate: 2010-03-14\nsummary: \"The Low Anthem: on to something\"\ntags:\n  - music\nimagePost: true\n---\nbody");
        assert_eq!(f.format, Some(Format::Yaml));
        assert_eq!(f.get("title"), Some("Crickets"));
        assert_eq!(f.get("summary"), Some("The Low Anthem: on to something"));
        assert_eq!(f.get("tags"), None);
        assert_eq!(f.get("imagepost"), Some("true"));
        assert_eq!(f.date(), Some(("2010".into(), "03".into(), "14".into())));
    }

    #[test]
    fn toml_frontmatter_with_quotes_and_comments() {
        let f = parse("+++\ntitle = 'Hugo post'\ndate = 2024-02-29T10:00:00Z\nslug = \"leap\" # chosen\ndraft = true\n[params]\nx = 1\n+++\n");
        assert_eq!(f.format, Some(Format::Toml));
        assert_eq!(f.get("title"), Some("Hugo post"));
        assert_eq!(f.get("slug"), Some("leap"));
        assert!(f.is_draft());
        assert_eq!(f.date().unwrap().0, "2024");
    }

    #[test]
    fn no_or_unclosed_frontmatter_is_nothing() {
        assert!(parse("# Just a heading\n").format.is_none());
        assert!(parse("---\ntitle: never closed\n").format.is_none());
        assert!(parse("").format.is_none());
    }
}
