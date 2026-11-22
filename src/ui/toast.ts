import { h } from "../lib/dom";

let host: HTMLElement | null = null;

/** A short message at the bottom of the window. Errors stay a little longer. */
export function toast(message: string, kind: "info" | "error" = "info", ms?: number) {
  if (!host) {
    host = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.appendChild(host);
  }
  const el = h("div", { class: `toast ${kind === "error" ? "error" : ""}` }, message);
  host.appendChild(el);
  const life = ms ?? (kind === "error" ? 7000 : 3200);
  setTimeout(() => {
    el.style.transition = "opacity .2s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 220);
  }, life);
  el.addEventListener("click", () => el.remove());
}
