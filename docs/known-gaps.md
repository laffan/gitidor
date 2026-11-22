# Known gaps

What is not done, not verified, or done in a simpler way than it could be.
Most important first.

## Not verified

1. **Never built for macOS, iPadOS or iOS.** Developed on Linux: the Rust
   crate compiles and its tests pass there, and the Tauri app builds and starts
   under WebKitGTK. Nothing has been through Xcode. The iOS-specific parts —
   `-lz -liconv` on the link line, the UIScene manifest — are taken from
   idlewild-editor, which does ship on iPad, but have not been exercised here.
2. **The `gitidor://` scheme on WKWebView.** Works in WebKitGTK (inline
   images, draft and live preview, link-back were all exercised in the running
   app there); the host-based addresses (`local.<id>`, `live.<id>`) and loads
   from a sandboxed frame have not been seen in WKWebView.
3. **HTTPS through libgit2 on Apple platforms.** Tested on Linux (OpenSSL);
   Apple targets use Secure Transport through libgit2-sys, as in idlewild.
4. **The AI calls.** Request shapes follow the providers' current
   documentation (Anthropic Messages with `output_config.format` and
   `fallbacks: "default"`; OpenAI Responses with `text.format`), and the
   parsing of their answers is unit-tested, but no request was sent from here
   — there was no key to send one with.
5. **The overlay title bar.** `titleBarStyle: "Overlay"` leaves room for the
   traffic lights by padding when the platform is macOS; the exact spacing has
   not been seen on a Mac.

## Not done

- **Keychain.** Secrets are in a 0600 file in the app's data directory, as in
  idlewild-editor. Keychain (macOS) and the iOS keychain are the better home.
- **OAuth sign-in.** GitHub sign-in is a pasted fine-grained token. The device
  flow would be friendlier on an iPhone but needs a registered OAuth app.
- **Merge conflicts.** A pull whose merge conflicts is refused with the files
  named; there is no conflict editor. Resolve on GitHub or elsewhere.
- **Shallow or partial clones.** Clones are full (libgit2 cannot push from a
  shallow clone). A repository with a very large history takes a while to add.
- **Git LFS.** Not supported; LFS-tracked images arrive as pointer files.
- **iPad status bar.** idlewild and hush hide it with a small Swift plugin
  (`tauri-plugin-ipad-chrome`); not ported.
- **Renaming files** has a backend command but no interface yet.
- **Shortcut customisation.** hush lets every shortcut be rebound; here they
  are fixed to hush's defaults, listed in Settings → Shortcuts.
- **Focus and typewriter modes** from hush/iA Writer are not ported.
- **Live preview fidelity.** The proxy serves pages with their own scripts,
  but with an opaque origin: anything that needs cookies or `localStorage`
  will not work in the preview. Static blogs are unaffected.
- **Windows and Android.** Not targets; the live preview's addressing would
  need a different scheme form there.
