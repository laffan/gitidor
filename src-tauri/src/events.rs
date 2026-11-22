//! What the backend tells the console: every git operation, network request
//! and long-running step, as it happens.
//!
//! One event, `log`, carries both kinds of report:
//!
//! - a **line** — "Pushed a1b2c3d to main", "GET /repos/… → 200 (180 ms)";
//! - a **progress update** — the same `task` id sent again and again with a
//!   growing `current`, which the console draws as one bar that fills rather
//!   than a hundred lines. The last one carries `done`.
//!
//! Lines are tagged with the repository they concern without every function
//! taking an id: commands that work on a repository open a [`scope`] on their
//! thread, and everything logged on that thread while it is open carries it.
//!
//! Before the app is running (tests) nothing is sent, and nothing fails.

use serde::Serialize;
use std::cell::RefCell;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

static APP: OnceLock<AppHandle> = OnceLock::new();

thread_local! {
    static REPO: RefCell<Option<String>> = const { RefCell::new(None) };
}

pub fn init(app: AppHandle) {
    let _ = APP.set(app);
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub task: String,
    pub label: String,
    pub current: u64,
    pub total: u64,
    /// What `current` and `total` count: `objects`, `bytes`.
    pub unit: &'static str,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEvent {
    pub level: Level,
    /// `git`, `github`, `ai`, `preview`, `files`, `app`.
    pub source: &'static str,
    pub message: String,
    pub repo_id: Option<String>,
    pub progress: Option<Progress>,
}

/// Tag everything logged on this thread with `id` until the guard drops.
pub struct Scope(Option<String>);

pub fn scope(id: &str) -> Scope {
    let previous = REPO.with(|r| r.replace(Some(id.to_string())));
    Scope(previous)
}

impl Drop for Scope {
    fn drop(&mut self) {
        let previous = self.0.take();
        REPO.with(|r| *r.borrow_mut() = previous);
    }
}

fn current_repo() -> Option<String> {
    REPO.with(|r| r.borrow().clone())
}

fn send(event: LogEvent) {
    if let Some(app) = APP.get() {
        let _ = app.emit("log", event);
    }
}

pub fn log(level: Level, source: &'static str, message: impl Into<String>) {
    if APP.get().is_none() {
        return;
    }
    // Anything that reaches the screen is checked for secrets first.
    let message = crate::secrets::redact(&message.into());
    send(LogEvent { level, source, message, repo_id: current_repo(), progress: None });
}

pub fn debug(source: &'static str, message: impl Into<String>) {
    log(Level::Debug, source, message);
}

pub fn info(source: &'static str, message: impl Into<String>) {
    log(Level::Info, source, message);
}

pub fn warn(source: &'static str, message: impl Into<String>) {
    log(Level::Warn, source, message);
}

/// A progress bar for one step. Updates are throttled to a few a second —
/// libgit2 reports every object, and every report would otherwise be an IPC
/// message the webview has to paint — except the first and the last.
pub struct Task {
    id: String,
    label: String,
    source: &'static str,
    unit: &'static str,
    last: RefCell<Option<Instant>>,
    repo: Option<String>,
}

pub fn task(source: &'static str, label: impl Into<String>, unit: &'static str) -> Task {
    Task {
        id: format!("{}-{}", source, crate::store::new_id()),
        label: label.into(),
        source,
        unit,
        last: RefCell::new(None),
        repo: current_repo(),
    }
}

impl Task {
    pub fn update(&self, current: u64, total: u64) {
        let now = Instant::now();
        let due = self.last.borrow().is_none_or(|t| now.duration_since(t) >= Duration::from_millis(150));
        if due || (total > 0 && current >= total) {
            *self.last.borrow_mut() = Some(now);
            self.emit(current, total, false);
        }
    }

    pub fn finish(&self, current: u64, total: u64) {
        self.emit(current, total, true);
    }

    fn emit(&self, current: u64, total: u64, done: bool) {
        if APP.get().is_none() {
            return;
        }
        send(LogEvent {
            level: Level::Debug,
            source: self.source,
            message: self.label.clone(),
            repo_id: self.repo.clone(),
            progress: Some(Progress { task: self.id.clone(), label: self.label.clone(), current, total, unit: self.unit, done }),
        });
    }
}

impl Drop for Task {
    /// A step that ends early (an error, a refusal) still closes its bar.
    fn drop(&mut self) {
        if self.last.borrow().is_some() {
            self.emit(0, 0, true);
        }
    }
}

/// `1.4 MB`, for progress lines.
pub fn size(bytes: u64) -> String {
    match bytes {
        b if b >= 1 << 20 => format!("{:.1} MB", b as f64 / 1048576.0),
        b if b >= 1 << 10 => format!("{:.0} KB", b as f64 / 1024.0),
        b => format!("{b} B"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scopes_nest_and_unwind() {
        assert_eq!(current_repo(), None);
        {
            let _a = scope("aaa");
            assert_eq!(current_repo().as_deref(), Some("aaa"));
            {
                let _b = scope("bbb");
                assert_eq!(current_repo().as_deref(), Some("bbb"));
            }
            assert_eq!(current_repo().as_deref(), Some("aaa"));
        }
        assert_eq!(current_repo(), None);
    }

    #[test]
    fn sizes_read_naturally() {
        assert_eq!(size(512), "512 B");
        assert_eq!(size(2048), "2 KB");
        assert_eq!(size(3 * 1048576 / 2), "1.5 MB");
    }
}
