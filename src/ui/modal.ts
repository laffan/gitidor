// A sheet over the window. Escape and a click outside close it unless it is
// busy; focus moves into it and back to where it was when it closes.

import { h, icon } from "../lib/dom";

export interface Modal {
  el: HTMLElement;
  body: HTMLElement;
  foot: HTMLElement;
  close: () => void;
  setBusy: (busy: boolean) => void;
}

export interface ModalOptions {
  title?: string;
  width?: number;
  className?: string;
  /** Called when the sheet closes, however it closes. */
  onClose?: () => void;
  /** Replace the standard head/body/foot with this content. */
  custom?: (close: () => void) => HTMLElement;
}

let openCount = 0;

export function openModal(opts: ModalOptions): Modal {
  const previous = document.activeElement as HTMLElement | null;
  let busy = false;
  const body = h("div", { class: "modal-body" });
  const foot = h("div", { class: "modal-foot" });

  const close = () => {
    if (!overlay.isConnected) return;
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    openCount--;
    opts.onClose?.();
    previous?.focus?.();
  };

  const dialog = opts.custom
    ? h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": opts.title ?? "" }, opts.custom(close))
    : h(
        "div",
        { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": opts.title ?? "" },
        h(
          "div",
          { class: "modal-head" },
          h("h3", null, opts.title ?? ""),
          h("button", { class: "icon-btn", type: "button", "aria-label": "Close", onclick: () => !busy && close() }, icon("x")),
        ),
        body,
        foot,
      );

  const overlay = h("div", { class: `modal-overlay ${opts.className ?? ""}` }, dialog);
  if (opts.width) overlay.style.setProperty("--modal-w", `${opts.width}px`);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay && !busy) close();
  });

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && !busy) {
      // Only the top sheet closes.
      if (overlay === [...document.querySelectorAll(".modal-overlay")].pop()) {
        e.stopPropagation();
        e.preventDefault();
        close();
      }
    }
  }
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(overlay);
  openCount++;
  requestAnimationFrame(() => {
    const first = dialog.querySelector<HTMLElement>("[autofocus], input:not([type=checkbox]):not([disabled]), textarea, select, .btn.primary");
    first?.focus();
  });

  return {
    el: overlay,
    body,
    foot,
    close,
    setBusy: (b: boolean) => {
      busy = b;
      dialog.querySelectorAll<HTMLButtonElement>(".modal-foot .btn").forEach((btn) => {
        if (!btn.dataset.keep) btn.disabled = b;
      });
    },
  };
}

export const modalIsOpen = () => openCount > 0;

/** Ask a yes-or-no question. */
export function confirmModal(title: string, message: string, confirm: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const m = openModal({ title, width: 420, onClose: () => !answered && resolve(false) });
    m.body.append(h("p", { style: "margin:0;line-height:1.5;color:var(--text-2)" }, message));
    const yes = h(
      "button",
      {
        class: `btn ${danger ? "danger" : "primary"}`,
        type: "button",
        onclick: () => {
          answered = true;
          m.close();
          resolve(true);
        },
      },
      confirm,
    );
    m.foot.append(h("button", { class: "btn quiet", type: "button", onclick: () => m.close() }, "Cancel"), yes);
    requestAnimationFrame(() => yes.focus());
  });
}

/** Ask for one line of text. */
export function promptModal(title: string, label: string, initial: string, confirm: string, hint?: string): Promise<string | null> {
  return new Promise((resolve) => {
    let answered = false;
    const m = openModal({ title, width: 440, onClose: () => !answered && resolve(null) });
    const input = h("input", { class: "input", value: initial, "aria-label": label });
    const submit = () => {
      const v = input.value.trim();
      if (!v) return;
      answered = true;
      m.close();
      resolve(v);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    m.body.append(h("div", { class: "field" }, h("label", null, label), input, hint ? h("div", { class: "hint" }, hint) : null));
    m.foot.append(h("button", { class: "btn quiet", type: "button", onclick: () => m.close() }, "Cancel"), h("button", { class: "btn primary", type: "button", onclick: submit }, confirm));
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  });
}
