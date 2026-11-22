// Appearance settings → CSS. Light or dark on `html[data-theme]`, following
// the system when the setting says so; the editor's font, size, line height
// and column width as custom properties every surface reads.

import type { Appearance } from "./types";

/**
 * The editor fonts on offer. IBM Plex is bundled and is the default — iA
 * asks that other editors use Plex rather than bundle or default to the iA
 * Writer fonts (which are Plex derivatives). Someone who has installed iA
 * Writer Duo or Quattro for themselves can choose them by name.
 */
export const FONTS: { key: string; label: string; family: string }[] = [
  { key: "plex-mono", label: "IBM Plex Mono", family: '"IBM Plex Mono", ui-monospace, Menlo, monospace' },
  { key: "plex-sans", label: "IBM Plex Sans", family: '"IBM Plex Sans", system-ui, sans-serif' },
  { key: "source-serif", label: "Source Serif 4", family: '"Source Serif 4", Georgia, serif' },
  { key: "system", label: "System (San Francisco)", family: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif' },
  { key: "system-serif", label: "System serif (New York)", family: 'ui-serif, "New York", Georgia, serif' },
  { key: "system-mono", label: "System mono (SF Mono)", family: 'ui-monospace, "SF Mono", Menlo, monospace' },
  { key: "ia-duo", label: "iA Writer Duo — if installed", family: '"iA Writer Duo S", "iA Writer Duo V", "iA Writer Duo", "IBM Plex Mono", monospace' },
  { key: "ia-quattro", label: "iA Writer Quattro — if installed", family: '"iA Writer Quattro S", "iA Writer Quattro V", "iA Writer Quattro", "IBM Plex Sans", sans-serif' },
  { key: "custom", label: "Other (type a font name)", family: "" },
];

export function fontFamily(a: Appearance): string {
  if (a.font === "custom" && a.customFont.trim()) return `${a.customFont.trim()}, "IBM Plex Mono", monospace`;
  return FONTS.find((f) => f.key === a.font)?.family || FONTS[0].family;
}

const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
let current: Appearance | null = null;
const themeListeners = new Set<(dark: boolean) => void>();

export function isDark(): boolean {
  return document.documentElement.dataset.theme === "dark";
}

export function onThemeChange(fn: (dark: boolean) => void) {
  themeListeners.add(fn);
}

export function applyAppearance(a: Appearance) {
  current = a;
  const root = document.documentElement;
  const dark = a.theme === "dark" || (a.theme === "system" && !!media?.matches);
  const was = root.dataset.theme;
  root.dataset.theme = dark ? "dark" : "light";
  root.style.setProperty("--editor-font", fontFamily(a));
  root.style.setProperty("--font-size", `${a.fontSize}px`);
  root.style.setProperty("--line-height", String(a.lineHeight));
  root.style.setProperty("--column", `${a.columnWidth}ch`);
  if (was !== root.dataset.theme) themeListeners.forEach((fn) => fn(dark));
}

media?.addEventListener("change", () => {
  if (current?.theme === "system") applyAppearance(current);
});
