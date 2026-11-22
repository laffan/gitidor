// What the live site said about a repository's post URLs (the `checks` on
// its site profile; see `livecheck.rs`), read for the interface: which check
// speaks for a folder, whether it still applies, and how to say it.

import { store } from "./store";
import type { Route, RouteCheck, SiteProfile } from "./types";

/** Whether a provider is chosen and its key saved, so the AI pass can run. */
export function aiReady(): boolean {
  const ai = store.settings.ai;
  return (ai.provider === "anthropic" && store.secrets.hasAnthropicKey) || (ai.provider === "openai" && store.secrets.hasOpenaiKey && !!ai.openaiModel);
}

/** Whether `check` was of `route` as it stands. */
export function checkIsFor(check: RouteCheck, route: Route): boolean {
  return check.folder === route.folder && check.pattern === route.pattern && (check.capture ?? "") === (route.capture ?? "");
}

/** The check for a content folder, if one was made of the routes as they are. */
export function checkFor(profile: SiteProfile | null | undefined, folder: string): RouteCheck | undefined {
  const check = profile?.checks?.find((c) => c.folder === folder);
  if (!check || !profile) return undefined;
  // A folder no route covered was checked with an empty pattern; any other
  // check must match a route that is still there.
  if (!check.pattern) return profile.routes.some((r) => r.folder === folder) ? undefined : check;
  return profile.routes.some((r) => checkIsFor(check, r)) ? check : undefined;
}

/** Folders whose URLs the live site has not confirmed. */
export function unconfirmed(profile: SiteProfile | null | undefined, folders: string[]): string[] {
  return folders.filter((f) => checkFor(profile, f)?.outcome !== "ok");
}

const SAMPLE_WORDS: Record<string, string> = {
  found: "found",
  reachable: "a page is there",
  different: "the page there is not this post",
  missing: "no page there",
  error: "the site did not answer",
};

/** One sample in a few words: "no page there (404)". */
export function sampleText(outcome: string, status: number): string {
  const words = SAMPLE_WORDS[outcome] ?? outcome;
  return status && outcome !== "found" && outcome !== "different" ? `${words} (${status})` : words;
}

/** "content/photos → /photo/{stem|number}/" */
export function routeLabel(check: RouteCheck): string {
  return `${check.folder} → ${check.pattern || "no route"}`;
}
