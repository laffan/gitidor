// A popover menu under a button: the hamburger beside a folder, the ⋯ on a
// repository card, the branch pill.

import { h, icon } from "../lib/dom";

export type MenuItem =
  | { label: string; icon?: string; run: () => void; danger?: boolean; checked?: boolean; disabled?: boolean }
  | { separator: true }
  | { heading: string };

let current: { el: HTMLElement; close: () => void } | null = null;

export function openMenu(anchor: HTMLElement, items: MenuItem[], align: "left" | "right" = "left") {
  current?.close();
  const menu = h("div", { class: "menu", role: "menu" });
  for (const item of items) {
    if ("separator" in item) menu.append(h("hr"));
    else if ("heading" in item) menu.append(h("div", { class: "menu-label" }, item.heading));
    else
      menu.append(
        h(
          "button",
          {
            type: "button",
            role: "menuitem",
            class: item.danger ? "danger" : "",
            disabled: item.disabled ?? false,
            onclick: () => {
              close();
              item.run();
            },
          },
          item.icon ? icon(item.icon) : null,
          h("span", null, item.label),
          item.checked ? h("span", { class: "check" }, icon("check", 14)) : null,
        ),
      );
  }
  document.body.appendChild(menu);

  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = align === "right" ? r.right - mw : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const onDown = (e: Event) => {
    if (!menu.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      anchor.focus();
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === "ArrowDown" ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  };
  function close() {
    menu.remove();
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("touchstart", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", close);
    if (current?.el === menu) current = null;
  }
  setTimeout(() => {
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("touchstart", onDown, true);
  });
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", close);
  current = { el: menu, close };
  return close;
}
