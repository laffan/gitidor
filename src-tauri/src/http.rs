//! One HTTP client for the three services this app talks to: GitHub's REST
//! API, the two AI providers, and the live site the preview proxies.
//!
//! `ureq` with `rustls`, as in idlewild-editor: it is blocking (every caller is
//! already on a blocking thread, because libgit2 is), it cross-compiles to
//! `aarch64-apple-ios` without a fight, and it brings no second TLS stack.
//!
//! **Status codes are not errors here.** ureq's default turns a 4xx into an
//! `Err` and drops the body, which is where both GitHub and the AI providers
//! say what was actually wrong. Callers get the status and the body and decide.

use std::sync::OnceLock;
use std::time::Duration;
use ureq::tls::{RootCerts, TlsConfig};
use ureq::Agent;

pub const USER_AGENT: &str = concat!("gitidor/", env!("CARGO_PKG_VERSION"));

/// For API calls: short connect timeout, generous overall, since an AI request
/// that is thinking can take a while to answer.
pub fn api() -> &'static Agent {
    static AGENT: OnceLock<Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        Agent::config_builder()
            .http_status_as_error(false)
            .timeout_connect(Some(Duration::from_secs(10)))
            .timeout_global(Some(Duration::from_secs(180)))
            .user_agent(USER_AGENT)
            .tls_config(tls())
            .build()
            .into()
    })
}

/// For the preview proxy: redirects are followed by hand (see `scheme.rs`),
/// so the page can be told where it really ended up.
pub fn proxy() -> &'static Agent {
    static AGENT: OnceLock<Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        Agent::config_builder()
            .http_status_as_error(false)
            .max_redirects(0)
            .timeout_connect(Some(Duration::from_secs(8)))
            .timeout_global(Some(Duration::from_secs(30)))
            .user_agent(USER_AGENT)
            .tls_config(tls())
            .build()
            .into()
    })
}

/// The system's trust store, not a bundled copy of Mozilla's. Proxies come
/// from the environment, which is ureq's default.
fn tls() -> TlsConfig {
    TlsConfig::builder().root_certs(RootCerts::PlatformVerifier).build()
}

/// A transport failure, said in terms somebody can act on.
pub fn transport_error(error: &ureq::Error, service: &str) -> String {
    match error {
        ureq::Error::Timeout(_) => format!("{service} did not answer in time."),
        ureq::Error::HostNotFound | ureq::Error::ConnectionFailed | ureq::Error::Io(_) => {
            format!("Cannot reach {service}. Check the network connection — editing and committing still work offline.")
        }
        other => format!("Cannot reach {service}: {other}"),
    }
}

/// Pull the most useful message out of an API error body.
///
/// GitHub answers `{"message": "..."}`; Anthropic and OpenAI both answer
/// `{"error": {"message": "..."}}`. Anything else is shown as it came, cut short.
pub fn error_message(body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(msg) = value.pointer("/error/message").and_then(|m| m.as_str()) {
            return msg.to_string();
        }
        if let Some(msg) = value.get("message").and_then(|m| m.as_str()) {
            return msg.to_string();
        }
    }
    body.chars().take(300).collect()
}

#[cfg(test)]
mod tests {
    use super::error_message;

    #[test]
    fn api_errors_are_read_from_either_shape() {
        assert_eq!(error_message(r#"{"message":"Bad credentials"}"#), "Bad credentials");
        assert_eq!(
            error_message(r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#),
            "invalid x-api-key"
        );
        assert_eq!(error_message("plain"), "plain");
    }
}
