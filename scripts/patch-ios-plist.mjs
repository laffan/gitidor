// Adapted from idlewild-editor (github.com/laffan/idlewild-editor @ a904b61),
// scripts/patch-ios-plist.mjs — the one block gitidor needs from it.
//
// The UIScene life cycle, which iOS 27 made compulsory: an app built against
// that SDK and still starting up the old way is refused at launch, with an
// EXC_BREAKPOINT in UIKit's
// `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`. Tauri's
// generated Info.plist does not declare it. `UIApplicationSupportsMultipleScenes`
// is the key tao reads to take the scene path at all; the configuration entry
// names tao's own delegate class so the two cannot disagree. idlewild's
// `Docs/ipad.md` has the full account.
//
// idlewild's other blocks are left out: gitidor opens no document types, and
// it serves its webview through a custom scheme rather than plain HTTP on
// loopback, so it needs no App Transport Security exception.
//
// Safe on every build: it exits quietly before `tauri ios init`, and skips a
// key that is already there. Runs from `beforeBuildCommand` (so `tauri ios
// build` applies it); run it by hand once after `tauri ios init` if you only
// ever use `tauri ios dev`.

import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const appleDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "gen", "apple");
if (!existsSync(appleDir)) process.exit(0);

const target = readdirSync(appleDir).find((n) => n.endsWith("_iOS") && existsSync(join(appleDir, n, "Info.plist")));
if (!target) process.exit(0);
const PLIST_PATH = join(appleDir, target, "Info.plist");

const SCENE_MANIFEST_XML = `\t<key>UIApplicationSceneManifest</key>
\t<dict>
\t\t<key>UIApplicationSupportsMultipleScenes</key>
\t\t<true/>
\t\t<key>UISceneConfigurations</key>
\t\t<dict>
\t\t\t<key>UIWindowSceneSessionRoleApplication</key>
\t\t\t<array>
\t\t\t\t<dict>
\t\t\t\t\t<key>UISceneConfigurationName</key>
\t\t\t\t\t<string>TaoScene</string>
\t\t\t\t\t<key>UISceneDelegateClassName</key>
\t\t\t\t\t<string>TaoSceneDelegate</string>
\t\t\t\t</dict>
\t\t\t</array>
\t\t</dict>
\t</dict>`;

let plist = readFileSync(PLIST_PATH, "utf-8");
if (plist.includes("<key>UIApplicationSceneManifest</key>")) process.exit(0);
const patched = plist.replace(/(\n)<\/dict>\s*<\/plist>/, `\n${SCENE_MANIFEST_XML}\n</dict>\n</plist>`);
if (patched === plist) {
  console.warn("⚠ Could not find where to add UIApplicationSceneManifest to Info.plist");
  process.exit(0);
}
writeFileSync(PLIST_PATH, patched, "utf-8");
console.log(`✓ Patched ${target}/Info.plist with UIApplicationSceneManifest`);
