# Architecture

## The split

The webview draws; Rust does everything that touches disk, git, the network or
a secret. Every command is in `src-tauri/src/lib.rs`, runs on a blocking
thread, and takes a per-repository lock for anything that uses git, so a fetch
started by opening a repository cannot interleave with a commit.

```
src/                         the interface (TypeScript, no framework)
  main.ts                    columns, window shortcuts, save-on-background
  lib/store.ts               what is showing; topics the columns subscribe to
  lib/actions.ts             what happens when somebody does something
  lib/ipc.ts                 every backend call, typed; mock outside Tauri
  lib/site.ts                image references → repository paths (site profile)
  lib/frontmatter.ts         YAML/TOML frontmatter; new-post naming and template
  lib/theme.ts               Appearance → CSS custom properties; night vision
  lib/log.ts                 the console's lines and progress bars
  lib/diff.ts                word-level differences for prose (Myers, paragraphs then words)
  lib/locate.ts              clicked preview text → offset in the markdown
  lib/published.ts           does a live page show a post's new version yet?
  ui/                        the three columns, every sheet, the console
  ui/diff-view.ts            the word-level change view: dot tooltip, Commit and Rollback sheets
  ui/resize.ts               draggable column edges, remembered per device
  ui/side-foot.ts            the footer under both side columns: Settings, night vision, console
  ui/rollback.ts             the Rollback sheet
  editor/editor.ts           CodeMirror setup
  editor/keymap.ts           the shortcut table (also drives Settings → Shortcuts)
  editor/frontmatter-ext.ts  keeps frontmatter out of the markdown parser; dim/fold;
                             marks lines the YAML/TOML parser rejects
  editor/images.ts           inline image widgets
  editor/hush/               ported from hush, kept close to the original
  mock/mock-backend.ts       in-memory backend for browser development

src-tauri/src/
  lib.rs          command surface
  store.rs        app data paths, JSON persistence, the path guard
  settings.rs     non-secret settings
  secrets.rs      token and keys; only their existence crosses IPC
  remote.rs       repository addresses (SSH form → HTTPS), branch-name rules
  github_api.rs   repository check, branches, Pages/CNAME, repository list
  gitops.rs       libgit2: clone, status, fetch, pull, commit, push, branches
  repos.rs        repository records, git locks, commit signature
  files.rs        folder listing, read/write, new files, image import
  frontmatter.rs  the handful of frontmatter fields listing and URLs need
  site.rs         site profiles: detection, URL patterns, sanitising
  ai.rs           Anthropic and OpenAI: key test, structured site detection
  scheme.rs       gitidor:// — local files and the live-site proxy
  http.rs         one ureq client; platform trust store; env proxies
  events.rs       the `log` event: lines and progress for the console
```

## Storage

Tauri's `app_data_dir` (the app container on iOS):

| File | What |
|---|---|
| `repos.json` | repositories: remote, public URL, folders, site profile |
| `settings.json` | appearance, commit defaults, AI provider and model |
| `secrets.json` | GitHub token and login, AI keys — mode 0600 |
| `clones/<id>/` | one full clone per repository |

Writes go to a temporary file renamed over the target, so a killed app leaves
the previous version, not half a file. The editor saves 800 ms after typing
stops, on ⌘S, and when the app goes to the background.

## Git

- **libgit2, vendored**, HTTPS only, token through a credentials callback as
  `x-access-token`. Never in a URL or `.git/config`. A refused token is not
  retried (libgit2 would otherwise loop).
- **Full clones.** libgit2 cannot push from a shallow clone.
- **Status, commit, branch, discard are local.** Fetch, pull and push are the
  only network calls, and only fetch happens without being asked (when a
  repository is opened, if "Check GitHub when a repository opens" is on).
- **Pull** fetches, then fast-forwards; if both sides moved it merges in
  memory first and only touches the working tree if the merge is clean.
  Checkouts are "safe": an uncommitted edit to a file the incoming commits
  change stops the pull with the file named, and nothing is overwritten.
- **Push** never forces. A rejection is read from the per-reference callback
  (libgit2 reports it there, not as an error from `push`).
- **Commit** takes exactly the files ticked in the sheet; a missing file is
  committed as a deletion. Author is from Settings, or the GitHub login and its
  no-reply address.
- **Rollback** is the one operation that discards work, so it is two calls.
  `repo_rollback_plan` lists what would go: for "local", every uncommitted
  change (untracked, non-ignored files included) against HEAD; for "remote",
  the commits `origin/<branch>` lacks plus every change since the merge base,
  so commits GitHub has and this copy does not are not shown as losses.
  `repo_rollback` takes the plan's HEAD and target ids and refuses if either
  has moved, then checks out the target with `remove_untracked` and resets
  the branch hard. libgit2's hard reset overrides the checkout strategy it is
  given, hence the separate checkout.
- **Status** also lists `unpushed`: the files changed between the merge base
  with `origin/<branch>` and HEAD, which the live preview uses to say whether
  the open post is on GitHub.

## Site profiles

`site.rs` reads a profile from the generator's config:

| Generator | Read from |
|---|---|
| Eleventy | `.eleventy.js` / `eleventy.config.*`: `dir.input`, `addPassthroughCopy` (both forms); folder data files (`posts/posts.json`, `*.11tydata.*`) for `permalink` |
| Jekyll | `_config.yml` `permalink` (`date`, `pretty`, `none`, or a `:token` pattern) |
| Hugo | `hugo.*` / `config.*` `contentDir`, `[permalinks]`; `static/` |
| Astro | `src/pages`, `src/content/<collection>`; `public/` |

Patterns use `{path} {stem} {fileSlug} {slug} {title} {year} {month} {day} {dir}`;
`{fileSlug}` follows Eleventy's `page.fileSlug` exactly (a leading
`YYYY-MM-DD-` and one hyphen removed). A frontmatter `permalink`/`url` wins;
`draft: true`, `published: false`, `private: true` and `permalink: false` mean
unpublished.

`ai.rs` sends the listing, config files, folder data files, the first lines of
two posts per folder and the rule-based guess, and asks for the same shape as a
strict JSON schema (`output_config.format` for Anthropic, `text.format` for
OpenAI's Responses API). Whatever comes back goes through `site::sanitize`:
folders and paths must exist and stay inside the repository.

## Preview

`gitidor://` is registered with `register_asynchronous_uri_scheme_protocol`;
the repository is in the host so a page's root-relative links stay inside the
same repository:

- `gitidor://local.<id>/<path>` — a file from the clone (inline images, draft
  preview, site stylesheets). Path-guarded.
- `gitidor://live.<id>/<path>` — the page from the public site, with absolute
  links to the site made root-relative and a short script added first in
  `<head>` that reports the page's path to the app, routes off-site links to
  the system browser, and answers back/forward/reload. Redirects are followed
  in Rust and a `<base>` added, since WebKit does not follow redirects from a
  scheme handler everywhere.

Both load in an iframe sandboxed without `allow-same-origin`: page scripts
run with an opaque origin and cannot reach Tauri's IPC. The draft frame is a
fixed `srcdoc` skeleton that receives rendered HTML by `postMessage`, so
inserted HTML never runs scripts and scroll position survives re-rendering.

**Clicking text.** Both frames carry the same small function
(`LOCATE_JS` in `preview.ts` and `scheme.rs`; a test keeps them identical).
On a click that is not on a link or control it takes the caret position
under the pointer (`caretRangeFromPoint`, or `caretPositionFromPoint`), finds
the enclosing block (paragraph, heading, list item…), and posts the block's
text before and after the caret and how far through the page the click was.
`lib/locate.ts` matches words, not characters, since the markdown has syntax
and link targets the rendered text does not: every occurrence of the clicked
word is scored by the longest common subsequence of up to six words either
side within twelve source words, plus a point each when the block's first or
last word is also the first or last word of that source line. Ties go to the
occurrence nearest the click's relative position. Below a minimum score
nothing moves. In the live preview only the open post's own page is searched.

**The live note.** The proxy's `nav` message also carries the page's
`innerText`. The note under the live page is drawn from git, per file: the
post has uncommitted changes, or is in `unpushed`, or the branch has no
upstream. A push records each pushed post as `origin/<branch>` had it before;
for fifteen minutes after, if the open post was in that push, the page text
is compared with both versions (`lib/published.ts`: three-word runs of the
rendered post missing from the page, the version missing fewer wins; rendering
differences hit both alike). Until the new one wins the note says the site may
still be rebuilding. It is redrawn on every status change and every page load.

The host-based form is how WebKit hands custom schemes to the app on macOS,
iOS and Linux. Windows and Android rewrite them to `http://gitidor.localhost`,
which loses the host — not a target platform, but noted.

## Word-level changes

`lib/diff.ts` runs Myers' O(ND) diff twice: over lines (paragraphs, in
markdown), then over the word, space and punctuation tokens of each changed
run of lines. A short unchanged stretch between two changes (a space, a word
of one or two letters) is folded into them and deletions are put before
insertions, so a rewritten phrase reads as one change. Each pass gives up past
a fixed number of edits and shows the run as one deletion and one insertion,
which bounds memory on a rewritten file. The older text comes from
`repo_show` (a file as HEAD, `origin/<branch>` or a plan's base has it); the
newer one is the editor's text for the open file and the disk's otherwise.

## Frontmatter validation

`frontmatterIssues` in `lib/frontmatter.ts` parses the block with `yaml`'s
`parseDocument` (every error, with its offsets) or `smol-toml` (the first
error, with its line). Only a parser error marks a line. YAML reports some
errors across a range, or on the line before the real problem (an
over-indented key is reported on its parent), so each error is placed on the
most suspicious line in or just after its range — one with no colon, an
unbalanced quote, an unclosed bracket, a second unquoted `: `, or indentation
under a line that opened no block. Those checks never mark a line by
themselves. Folded frontmatter unfolds while it has an error.

## The console

`events.rs` sends one Tauri event, `log`, for both kinds of report: a line
(level, source, message) and a progress update (the same task id with a
growing count, `done` on the last). Commands that work on a repository open a
thread-local scope, so everything logged during them carries its id without
being passed one. libgit2's callbacks feed it: `transfer_progress` and
`push_transfer_progress` drive the bars (throttled to a few updates a second),
`sideband_progress` gives the server's `remote:` lines, and
`push_update_reference` reports each reference GitHub accepted or refused.
Every message goes through `secrets::redact` before it is sent.

On the webview side `lib/log.ts` keeps the last 3,000 lines and the active
tasks, merges repeats (the same failure reported by the backend and by the
call that saw it) into one line with a count, and repaints at most once a
frame. `ipc.ts` adds a line for every backend call with its duration, except
the few made constantly. The log lives in memory; it starts empty each launch.

## Secrets

The token and keys are read from `secrets.json` at the moment of a call and
never returned to the webview; the interface is told only whether each exists
and, for GitHub, the login. Messages shown to the person pass through
`secrets::redact`. The file is 0600 in the app's data directory; Keychain is
the obvious improvement (see known gaps).
