# gitidor

A columnar markdown editor for static sites that live in GitHub repositories,
for macOS, iPadOS and iOS. Tauri v2, with libgit2 linked in so the same git
works on an iPad, where an app cannot run `git`.

Add a repository once — it is cloned to the device — choose the folders your
posts live in, and from then on you write, commit, switch branches and preview
without a network. Only pulling and pushing need one.

```
┌──────────────┬────────────────┬───────────────────────────────────────────┐
│ Repositories │ Files          │  posts / 2026-11-02--marettimo.md   Saved 👁 │
│              │                │                                           │
│ ┌──────────┐ │ ▾ posts      ☰ │   ---                                     │
│ │ blog     │ │   Marettimo  ● │   title: Marettimo                        │
│ │ ⑂ main   │ │   Lisboa       │   ---                                     │
│ │ 1 change │ │   Thrum        │   The ferry from Trapani takes an hour…   │
│ │ ↓ ✓ ↑ ⋯  │ │                │   ![](/images/blog/harbour.jpg)           │
│ └──────────┘ │ + Add Folder   │   ┌─────────── the image ──────────┐      │
│ + Add Repo   │                │                                           │
│ ⚙            │                │   101 words          blog…/blog/-marettimo/│
└──────────────┴────────────────┴───────────────────────────────────────────┘
```

## The three columns

**Repositories.** Hidden when the app opens (unless there are none yet); the
sidebar button beside the repository's name at the top of the Files column
shows and hides it. One card per repository: its branch (tap to switch or make
one), how many files have changed, how many commits are ahead of or behind
GitHub, and the last commit. The selected card has Pull, Commit, Push, Open
site and a menu with the repository's settings, AI site detection, **Roll
back** (to the last remote commit, or to the last local commit), Open on
GitHub and Remove. **Add Repo** is always last.

**Settings** is the gear in the lower-left corner; beside it are **Night
vision** and the **Console** button. They are in a footer the repositories and
Files columns share, so they stay in reach when the repositories are hidden.

**Files.** The folders you chose, each listing its markdown files newest
first, with titles from frontmatter and a dot for anything changed. The
**globe** beside the repository's name shows the published site, from its
home page, in the editor column in place of the post, in the live preview's
small browser (back, forward, reload, the address). When a page is one a file
was built from, **Edit Post** appears in the bar, and the file is scrolled to
the top of the Files column and outlined (its folder opens if it was
closed). Edit Post, or clicking the file, opens it in the editor and the site
goes; × or Esc goes back to the post that was open. Rest the
pointer on a dot to see what changed in that file since the last commit, word
by word: deletions struck through in red, insertions highlighted in green.
When the repository has changes, a **Commit** button with their count sits
across from its name. The ☰ across from a folder's name has New post, Refresh
and Remove. **Add Folder** is always last. Its switch chooses the kind of
folder: a **content folder** (posts; the picker counts each folder's markdown
and marks the ones the site's config says hold posts) or an **upload folder**.

An **upload folder** lists every file in it — images as thumbnails, other
files by type — as icons, or as a list from its ☰ menu. The **+** beside the ☰
picks files to copy in (files can also be dropped on the folder); a name that
is already there gets a number added rather than replacing the file. Uploads
are new files like any other edit: they get a dot, and committing and pushing
puts them on the site. GitHub refuses files over 100 MB, so those are left
out. Clicking a picture, video or sound file shows it in the editor column in
place of the post, with its size, dimensions or length, and the address the
site serves it at; **Insert into post** puts its markdown at the post's caret,
and Esc or × goes back to the post. Clicking any other file (or right-clicking
any file) opens its menu: Insert into post, Copy markdown, Delete. Dragging a
file into the editor inserts it too. In the picker, the folders the site maps image URLs to
are marked.

Every column's edge can be dragged to change its width, and so can the line
between the editor and the preview; double-click an edge to put it back.
Widths are remembered on the device.

**Editor.** CodeMirror 6, set up the way [hush](https://github.com/laffan/hush)
sets it up for prose, with every hush text-editing shortcut on hush's keys
(sentence and paragraph selection and movement, join lines, move lines,
⌘D instance stepping, ⌥-click multi-cursor, bold/italic/highlight/strike/
quote/comment). Frontmatter in YAML (`---`) or TOML (`+++`) is kept out of the
markdown parser and shown dimmed, folded, or plain; a frontmatter line the
YAML (or TOML) parser rejects turns red, with the reason on hover. A
frontmatter value that names a file in an upload folder (`image:
/images/blog/harbour.jpg`, `attachments: [menu.pdf]`) gets a small button
after it: resting the pointer on it previews the file, clicking it opens the
file (pictures, video and sound in the viewer) and finds it in its upload
folder. Images a post names are
drawn under the line that names them. Paste or drop an image to save it into
the repository where the site expects images and insert a reference to it.
Saving is automatic.

The 👁 button opens the **preview** beside the text:

- **Live**, what it opens to, loads the published site through a small proxy.
  As you click around, it works out which source file each page came from and
  offers **Edit this post**. It shows what is pushed and built, and says so
  when the open post has changes that are not pushed yet, or was pushed but
  the page does not show the new version yet (the site is still rebuilding);
  the note goes when the page catches up. Without a public address it opens on
  Draft instead.
- **Draft** renders the file as typed, offline, with images resolved the same
  way the editor resolves them.

Click text in either and the editor moves to the same words, with the caret
there. The rendered text has no markdown syntax and the source has no
rendering, so this matches words, not characters: the clicked word and the
words around it.

## Commit and roll back

The **Commit** sheet lists every changed file, ticked, and shows the selected
one's changes word by word, the same way as the dots' tooltips: paragraphs
are single lines in markdown, so a line diff could only say that a paragraph
changed.

**Roll back** in a repository's menu has two choices:

- **To last local commit** drops every uncommitted change, new files
  included (ignored files are left alone).
- **To last remote commit** also drops the commits GitHub does not have,
  putting the branch where GitHub's was when the app last checked.

Either one first shows what would be lost — the commits, and each file's
changes word by word — and asks. It refuses if anything moved in between.

## Night vision

The eye beside Settings (and Settings → Appearance) draws the whole window,
previews included, in shades of red with no blue or green light, as
[snorkle](https://github.com/laffan/snorkle) does: one layer reduces what is
under it to grey, a second multiplies that by pure red. It pairs best with
the Dark appearance.

## Console

The button beside Settings (or ⇧⌘Y) slides a console up from the bottom of
the window. It shows what the app is doing as it does it:

- **git** — clone, fetch, pull, commit, push, branch switches and discards,
  with the server's own `remote:` messages, which reference GitHub accepted or
  refused, and the commit range a push sent;
- **GitHub** — every API request with its status and time, and a warning when
  the hourly rate limit is nearly used up;
- **AI** — which provider and model was asked, how long it took, the tokens
  used, and whether a fallback model answered;
- **Preview** — each page the live preview loaded, redirects, and any image a
  post names that is not in the repository;
- **App** — opening, saving, creating and deleting files, folder changes,
  going offline and back, and every backend call with its duration.

Steps in flight (receiving a clone, sending a push) are progress bars at the
top that fill and disappear. Routine lines (call timings, `remote:` messages,
asset loads, saves) are hidden until **Details** is on. The filter tabs and
search narrow it down; Copy puts what is shown on the clipboard for a bug
report. Errors arriving while it is closed put a red count on its button. The
panel's height is remembered; drag its top edge to change it. Tokens and keys
never appear in it: every backend line passes through the same redaction as
error messages.

## Site structure

A post says `![](/images/blog/a.jpg)`; the file is often somewhere else —
in the blog this was written for, `public/blog-images/a.jpg`, because
`.eleventy.js` copies one to the other at build time. Each repository gets a
**site profile**: which folders hold posts, the URL pattern each is published
at, and where URL prefixes live in the repository. It is read from the
generator's own config when the repository is added (Eleventy, Jekyll, Hugo
and Astro are understood directly), can be worked out again by an AI provider
when the config is unusual, and can be read and edited by hand in the
repository's settings. Inline images, the draft preview, published URLs and
"Edit this post" all come from it.

For `laffan/blog.natelaffan.com` the rule-based reading gives `posts` →
`/blog/{fileSlug}/` (so `posts/2010-03-14--crickets.md` is
`/blog/-crickets/`, which is what the live site serves) and `/images/blog/` →
`public/blog-images/`, with `https://blog.natelaffan.com/` found from the
`CNAME` file.

## Download

Mac builds are on the [Releases](https://github.com/laffan/gitidor/releases)
page: `AppleSilicon.dmg` for M-series Macs, `MacIntel.dmg` for Intel Macs.
They need macOS 12 or later. They are not signed with an Apple Developer
certificate, so macOS blocks the app the first time; after dragging it to
Applications, run this once in Terminal:

```sh
xattr -cr "/Applications/gitidor.app"
```

The iPad and iPhone apps are not on the Releases page: they are built and
installed from Xcode, as described under Setting up.

Releases are made by the Release workflow (`.github/workflows/release.yml`):
Actions → Release → Run workflow builds both Mac installers and attaches them
to a draft release tagged `v` plus the version in `src-tauri/tauri.conf.json`.
Publish the draft on GitHub to release it.

## Setting up

```sh
npm install
npm run tauri dev        # the app, on this machine
npm run dev              # the interface alone in a browser, against an in-memory mock
npm test                 # frontend tests
cd src-tauri && cargo test               # backend tests
cargo test -- --ignored                  # also the ones that need the network
```

On Linux the Tauri build needs the WebKitGTK development packages
(`libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev`).

**macOS:** `npm run build:macos` makes an app bundle in
`src-tauri/target/release/bundle/macos/`.

**iPad and iPhone:** Xcode with the iOS SDK, and
`rustup target add aarch64-apple-ios aarch64-apple-ios-sim`. Then
`npm run ios:init` once (it runs `tauri ios init` and two patches from
idlewild-editor: the UIScene manifest iOS 27 requires, and `-lz -liconv` on the
link line, which libgit2 needs on iOS and which the Xcode link does not get
from Cargo). After that `npm run ios:dev` or `npm run build:ios`. Set your
development team in `src-tauri/tauri.conf.json` (`bundle.iOS.developmentTeam`)
or `APPLE_DEVELOPMENT_TEAM`.

**GitHub:** Settings → GitHub takes a fine-grained personal access token with
**Contents: Read and write** on the repositories you edit (and Pages: read if
you want custom domains found automatically). Public repositories clone without
one; pushing needs it. The token stays in Rust and is never sent to the
webview.

**AI (optional):** Settings → AI takes an Anthropic or OpenAI key. Test lists
the models the key can use; Anthropic defaults to Claude Opus 5.5. The key is
used only when you ask for a repository's structure to be worked out, and what
is sent is the file listing, the config files and the first lines of a few
posts.

## Shortcuts

All of hush's text-editing shortcuts, plus: ⌘S save now, ⇧⌘P preview,
⌘\ hide the side columns (and bring back the ones that were showing),
⇧⌘K commit, ⌘N new post, ⇧⌘Y console,
⌘, settings. The full
list is in Settings → Shortcuts.

## What has and has not been run

Developed on Linux. Verified there:

- **Rust tests** — git against local bare repositories (clone, commit chosen
  files, push, fast-forward and merging pulls, refusing a conflicting merge
  without touching anything, never overwriting an uncommitted edit, branches,
  discard, diff, a file as a commit has it, the files unpushed commits change,
  rolling back to the last local or remote commit and refusing a stale plan), site detection, URL patterns, path guards, the preview
  scheme. Network tests (`--ignored`): a real HTTPS clone and fetch through
  libgit2, GitHub's API for a real repository (including finding a custom
  domain from `CNAME`), and the live-preview proxy against the real blog.
- **Frontend tests** — asset resolution, frontmatter in both formats and its
  line-by-line validation, new-post naming and templates; the word-level diff,
  finding clicked preview text in the markdown, telling whether a live page
  shows a post's new version, and that the click script is the same in the
  draft preview and in live pages.
- **In Chromium against the mock** — every column and sheet at desktop, iPad
  and iPhone widths, light and dark; hush's shortcuts acting on text; autosave,
  the commit sheet and new posts; the change tooltip, the Roll back submenu and
  sheet, dragging column edges, night vision over the preview, clicking draft
  preview text to move the editor, and the live preview's note through an
  edit, a push, and the page catching up (with a stand-in page that reports
  its text as the proxy's script does). The site browser from the globe, with
  stand-in pages the same way: Edit Post on a post's page and not on others,
  the Files column scrolling the post under its folder's name (a closed
  folder opening, room added under the last posts), and opening the post
  from either place.
- **The Tauri app itself, built and run on Linux (WebKitGTK)** with a copy of
  the blog: the folder listing, opening posts, inline images through
  `gitidor://local`, the draft preview, the live preview through the proxy,
  following a link in the live site and opening its source with *Edit this
  post* (before the site browser was added; it uses the same frame and
  proxy, but has not been run in the app), and an edit committed and pushed through libgit2 (to a local bare
  repository, not GitHub), with the console showing the backend's lines for
  each step.

**Not yet built or run on macOS, an iPad or an iPhone.** The iOS pieces
follow what idlewild-editor ships, but nothing here has been through Xcode.
See [docs/known-gaps.md](docs/known-gaps.md).

## Where things are

See [docs/architecture.md](docs/architecture.md).

## Credits

- Editing commands and markdown extensions: ported from
  [hush](https://github.com/laffan/hush) (`src/editor/hush/`).
- GitHub and libgit2 approach, error wording, and the iOS build patches:
  adapted from [idlewild-editor](https://github.com/laffan/idlewild-editor).
- Night vision: [snorkle](https://github.com/laffan/snorkle)'s icon and its
  two-layer way of drawing it.
- The preview is not [snorkle](https://github.com/laffan/snorkle): snorkle
  hosts its own WKWebViews from Rust, which is far more browser than a
  preview needs and would mean an unverified objc2 layer here. The live
  preview borrows its idea of keeping page content away from the app (a
  sandboxed frame with an opaque origin) instead.
- Type: IBM Plex Mono and Sans, Source Serif 4. iA asks other editors not to
  bundle or default to the iA Writer fonts, so they are offered only by name,
  for people who have installed them.
