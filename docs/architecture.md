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
  lib/theme.ts               Appearance → CSS custom properties
  ui/                        the three columns and every sheet
  editor/editor.ts           CodeMirror setup
  editor/keymap.ts           the shortcut table (also drives Settings → Shortcuts)
  editor/frontmatter-ext.ts  keeps frontmatter out of the markdown parser; dim/fold
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

The host-based form is how WebKit hands custom schemes to the app on macOS,
iOS and Linux. Windows and Android rewrite them to `http://gitidor.localhost`,
which loses the host — not a target platform, but noted.

## Secrets

The token and keys are read from `secrets.json` at the moment of a call and
never returned to the webview; the interface is told only whether each exists
and, for GitHub, the login. Messages shown to the person pass through
`secrets::redact`. The file is 0600 in the app's data directory; Keychain is
the obvious improvement (see known gaps).
