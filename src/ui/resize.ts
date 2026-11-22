// Drag a column's edge to change its width: the repositories and Files
// columns, and the line between the editor and the preview. Double-click
// puts it back; arrow keys move it when it has focus. Remembered on this
// device, like the console's height.

import { h } from "../lib/dom";

type Which = "repos" | "files" | "preview";

const KEY = "gitidor.widths";
const LIMITS = { repos: [180, 420], files: [200, 560] } as const;
/** The editor column keeps at least this much room. */
const EDITOR_MIN = 360;

let saved: Partial<Record<Which, number>> = {};
try {
  saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
} catch {
  saved = {};
}

const app = () => document.getElementById("app");

function apply(which: Which, value: number | undefined) {
  const el = which === "preview" ? document.documentElement : app();
  const prop = `--${which}-w`;
  if (value === undefined) el?.style.removeProperty(prop);
  else el?.style.setProperty(prop, which === "preview" ? `${(value * 100).toFixed(2)}%` : `${Math.round(value)}px`);
}

function remember() {
  try {
    localStorage.setItem(KEY, JSON.stringify(saved));
  } catch {
    /* a private window: widths are just not remembered */
  }
}

/** Put the remembered widths back; call once the columns are in the page. */
export function restoreWidths() {
  for (const which of ["repos", "files", "preview"] as Which[]) apply(which, saved[which]);
}

function columnWidth(which: "repos" | "files"): number {
  return document.querySelector<HTMLElement>(`.col-${which}`)?.getBoundingClientRect().width ?? LIMITS[which][0];
}

function clampColumn(which: "repos" | "files", w: number): number {
  const other = which === "repos" ? columnWidth("files") : document.getElementById("app")?.classList.contains("hide-repos") || matchMedia("(max-width: 1080px)").matches ? 0 : columnWidth("repos");
  const [min, max] = LIMITS[which];
  return Math.max(min, Math.min(max, w, window.innerWidth - other - EDITOR_MIN));
}

function set(which: Which, value: number) {
  saved[which] = value;
  apply(which, value);
}

export function resizeHandle(which: Which): HTMLElement {
  const label = which === "repos" ? "Resize the repositories column" : which === "files" ? "Resize the Files column" : "Resize the preview";
  const el = h("div", {
    class: `col-resize resize-${which}`,
    role: "separator",
    "aria-orientation": "vertical",
    "aria-label": label,
    tabindex: "0",
    title: "Drag to resize · double-click to reset",
  });

  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const root = app();
    root?.classList.add("resizing");
    el.classList.add("active");
    const startX = e.clientX;
    const startW = which === "preview" ? 0 : columnWidth(which);
    const split = el.closest(".editor-split")?.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      if (which === "preview") {
        if (!split || split.width <= 0) return;
        set("preview", Math.max(0.2, Math.min(0.8, (split.right - ev.clientX) / split.width)));
      } else {
        set(which, clampColumn(which, startW + (ev.clientX - startX)));
      }
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointercancel", up);
      root?.classList.remove("resizing");
      el.classList.remove("active");
      remember();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up, { once: true });
    el.addEventListener("pointercancel", up, { once: true });
  });

  el.addEventListener("dblclick", () => {
    delete saved[which];
    apply(which, undefined);
    remember();
  });

  el.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = e.key === "ArrowRight" ? 16 : -16;
    if (which === "preview") {
      const split = el.closest(".editor-split")?.getBoundingClientRect();
      const now = saved.preview ?? 0.5;
      if (split?.width) set("preview", Math.max(0.2, Math.min(0.8, now - step / split.width)));
    } else {
      set(which, clampColumn(which, columnWidth(which) + step));
    }
    remember();
  });
  return el;
}
