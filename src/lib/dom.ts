// A small element builder and the icon set. No framework: the interface is a
// handful of lists and sheets, re-rendered when the store says they changed.

type Child = Node | string | number | null | undefined | false | Child[];
type Handler = (e: Event) => void;
export type Props = Record<string, unknown> & {
  class?: string | false | null;
  style?: string | Partial<CSSStyleDeclaration>;
  dataset?: Record<string, string>;
};

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") el.className = String(value);
      else if (key === "style") {
        if (typeof value === "string") el.setAttribute("style", value);
        else Object.assign(el.style, value);
      } else if (key === "dataset") Object.assign(el.dataset, value as Record<string, string>);
      else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value as Handler);
      else if (key === "html") el.innerHTML = String(value);
      else if (key in el && typeof value !== "string") (el as unknown as Record<string, unknown>)[key] = value;
      else if (value === true) el.setAttribute(key, "");
      else el.setAttribute(key, String(value));
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Replace an element's children, keeping its scroll position. */
export function replace(el: Element, ...children: Child[]) {
  const top = el.scrollTop;
  clear(el);
  append(el, children);
  el.scrollTop = top;
}

// Stroke icons on a 24-unit grid, drawn at 16px.
const PATHS: Record<string, string> = {
  plus: "M12 5v14M5 12h14",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z",
  branch: "M6 3v12 M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M18 9a9 9 0 0 1-9 9",
  pull: "M12 4v12 M6 10l6 6 6-6 M5 20h14",
  push: "M12 20V8 M6 14l6-6 6 6 M5 4h14",
  commit: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M3 12h6 M15 12h6",
  check: "M5 12.5l4.5 4.5L19 7.5",
  refresh: "M20 11a8 8 0 0 0-14.3-4.9L4 8 M4 4v4h4 M4 13a8 8 0 0 0 14.3 4.9L20 16 M20 20v-4h-4",
  more: "M5 12h.01 M12 12h.01 M19 12h.01",
  menu: "M4 7h16 M4 12h16 M4 17h16",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  x: "M6 6l12 12 M18 6 6 18",
  sidebar: "M3 5h18v14H3z M9 5v14",
  external: "M14 4h6v6 M20 4l-9 9 M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z M14 3v5h5",
  back: "M15 18l-6-6 6-6",
  forward: "M9 18l6-6-6-6",
  chevron: "M6 9l6 6 6-6",
  edit: "M4 20h4L19 9l-4-4L4 16Z M13.5 6.5l4 4",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8Z",
  trash: "M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M3 12h18 M12 3a14 14 0 0 1 0 18 M12 3a14 14 0 0 0 0 18",
  type: "M4 7V5h16v2 M9 19h6 M12 5v14",
  github: "M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21",
  keyboard: "M3 6h18v12H3z M7 10h.01 M11 10h.01 M15 10h.01 M7 14h10",
  undo: "M9 14 4 9l5-5 M4 9h11a5 5 0 0 1 0 10h-2",
  image: "M4 5h16v14H4z M4 16l5-5 4 4 3-3 4 4 M15 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z",
  cloudoff: "M3 3l18 18 M8 6.5A6 6 0 0 1 17.7 10H18a4 4 0 0 1 2.6 7 M16 18H7a5 5 0 0 1-1.7-9.7",
};

export function icon(name: keyof typeof PATHS | string, size = 16): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", name === "more" ? "3" : "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of (PATHS[name] ?? "").split(" M")) {
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", d.startsWith("M") ? d : `M${d}`);
    svg.appendChild(p);
  }
  return svg;
}

export function iconButton(name: string, title: string, onclick: (e: MouseEvent) => void, extra?: Props): HTMLButtonElement {
  return h("button", { class: "icon-btn", title, "aria-label": title, type: "button", onclick, ...extra }, icon(name));
}

/** "3 minutes ago", for card and file footers. */
export function ago(ms: number, now = Date.now()): string {
  if (!ms) return "never";
  const s = Math.round((now - ms) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} hr ago`;
  const d = Math.round(hr / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** A CodeMirror key name as the Mac menus write it: Mod-Shift-l → ⇧⌘L. */
export function keyLabel(key: string): string {
  const parts = key.split("-");
  const last = parts.pop() ?? "";
  const names: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Backspace: "⌫", Enter: "↩", Escape: "esc" };
  const mods = new Set(parts);
  let out = "";
  if (isMac) {
    if (mods.has("Ctrl")) out += "⌃";
    if (mods.has("Alt")) out += "⌥";
    if (mods.has("Shift")) out += "⇧";
    if (mods.has("Mod") || mods.has("Cmd")) out += "⌘";
  } else {
    const order = [mods.has("Mod") || mods.has("Ctrl") ? "Ctrl" : "", mods.has("Alt") ? "Alt" : "", mods.has("Shift") ? "Shift" : ""].filter(Boolean);
    out = order.length ? `${order.join("+")}+` : "";
  }
  return out + (names[last] ?? (last.length === 1 ? last.toUpperCase() : last));
}
