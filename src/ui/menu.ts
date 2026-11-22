// A popover menu under a button: the hamburger beside a folder, the ⋯ on a
// repository card, the branch pill. An item with a `submenu` opens a second
// menu beside it, on hover, click or →.

import { h, icon } from "../lib/dom";

export type MenuItem =
  | { label: string; icon?: string; run: () => void; danger?: boolean; checked?: boolean; disabled?: boolean; title?: string }
  | { label: string; icon?: string; submenu: MenuItem[]; disabled?: boolean }
  | { separator: true }
  | { heading: string };

let current: { el: HTMLElement; close: () => void } | null = null;

/** Build one menu panel. `onRun` closes the whole menu before an item runs. */
function panel(items: MenuItem[], onRun: () => void, openSub: (item: HTMLElement, sub: MenuItem[]) => void, closeSub: () => void): HTMLElement {
  const menu = h("div", { class: "menu", role: "menu" });
  for (const item of items) {
    if ("separator" in item) menu.append(h("hr"));
    else if ("heading" in item) menu.append(h("div", { class: "menu-label" }, item.heading));
    else if ("submenu" in item) {
      const btn: HTMLButtonElement = h(
        "button",
        {
          type: "button",
          role: "menuitem",
          class: "has-submenu",
          "aria-haspopup": "menu",
          disabled: item.disabled ?? false,
          onclick: () => openSub(btn, item.submenu),
          onmouseenter: () => openSub(btn, item.submenu),
        },
        item.icon ? icon(item.icon) : null,
        h("span", null, item.label),
        h("span", { class: "check" }, icon("forward", 14)),
      );
      menu.append(btn);
    } else
      menu.append(
        h(
          "button",
          {
            type: "button",
            role: "menuitem",
            class: item.danger ? "danger" : "",
            disabled: item.disabled ?? false,
            title: item.title,
            onmouseenter: closeSub,
            onclick: () => {
              onRun();
              item.run();
            },
          },
          item.icon ? icon(item.icon) : null,
          h("span", null, item.label),
          item.checked ? h("span", { class: "check" }, icon("check", 14)) : null,
        ),
      );
  }
  return menu;
}

export function openMenu(anchor: HTMLElement, items: MenuItem[], align: "left" | "right" = "left") {
  current?.close();
  let sub: { el: HTMLElement; from: HTMLElement } | null = null;

  const closeSub = () => {
    if (!sub) return;
    sub.from.classList.remove("open");
    sub.el.remove();
    sub = null;
  };
  const openSub = (from: HTMLElement, list: MenuItem[]) => {
    if (sub?.from === from) return;
    closeSub();
    const el = panel(list, close, () => undefined, () => undefined);
    el.classList.add("submenu");
    document.body.appendChild(el);
    const r = from.getBoundingClientRect();
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    let left = r.right + 2;
    if (left + w > window.innerWidth - 8) left = Math.max(8, r.left - w - 2);
    const top = Math.max(8, Math.min(r.top - 5, window.innerHeight - hgt - 8));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    from.classList.add("open");
    sub = { el, from };
  };

  const menu = panel(items, close, openSub, closeSub);
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

  const inside = (t: EventTarget | null) => menu.contains(t as Node) || !!sub?.el.contains(t as Node);
  const onDown = (e: Event) => {
    if (!inside(e.target) && e.target !== anchor && !anchor.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    const inSub = !!sub && sub.el.contains(document.activeElement);
    if (e.key === "Escape") {
      e.stopPropagation();
      if (inSub && sub) {
        const from = sub.from;
        closeSub();
        from.focus();
        return;
      }
      close();
      anchor.focus();
    }
    if (e.key === "ArrowRight" && !inSub && document.activeElement?.classList.contains("has-submenu")) {
      e.preventDefault();
      (document.activeElement as HTMLElement).click();
      sub?.el.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    }
    if (e.key === "ArrowLeft" && inSub && sub) {
      e.preventDefault();
      const from = sub.from;
      closeSub();
      from.focus();
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const within = inSub && sub ? sub.el : menu;
      const buttons = [...within.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === "ArrowDown" ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  };
  function close() {
    closeSub();
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
