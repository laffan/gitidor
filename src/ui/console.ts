// The console: a panel that slides up from the bottom of the window and shows
// everything the app is doing — git and its progress, GitHub requests, AI
// calls, the live preview's page loads, saves and file operations, and the
// timing of every backend call.
//
// Steps in flight (a clone, a push) are bars at the top that fill and then
// disappear; everything else is a line. "Details" adds the routine lines
// (call timings, remote messages, asset loads) that are hidden by default.

import { h, icon, iconButton } from "../lib/dom";
import { emit, on, repoById, store } from "../lib/store";
import { asText, clearLog, entries, setConsoleOpen, tasks, timeLabel, unseenErrors, type LogEntry } from "../lib/log";
import { toast } from "./toast";

type Filter = "all" | "git" | "github" | "ai" | "preview" | "app";

const FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["git", "Git"],
  ["github", "GitHub"],
  ["ai", "AI"],
  ["preview", "Preview"],
  ["app", "App"],
];

const HEIGHT_KEY = "gitidor.consoleHeight";

function savedHeight(): number {
  try {
    const n = Number(localStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(n) && n >= 120 ? n : 0;
  } catch {
    return 0;
  }
}

export function toggleConsole(open = !store.console.open) {
  store.console.open = open;
  setConsoleOpen(open);
  emit("console");
}

export function consolePanel(): HTMLElement {
  let filter: Filter = "all";
  let details = false;
  let query = "";
  let renderedUpTo = 0;
  let renderedKey = "";

  const list = h("div", { class: "console-log", role: "log", "aria-live": "off" });
  const taskBox = h("div", { class: "console-tasks" });
  const segmented = h("div", { class: "segmented small", role: "tablist" });
  const detailsBox = h("input", { type: "checkbox", class: "switch", title: "Show routine lines: call timings, remote messages, asset loads" });
  const search = h("input", { class: "input search", type: "search", placeholder: "Filter", "aria-label": "Filter the console" });
  const count = h("span", { class: "console-count" });

  const copy = iconButton("copy", "Copy what is shown", () => {
    const text = asText(visible(), repoName);
    void navigator.clipboard?.writeText(text).then(
      () => toast("Console copied."),
      () => toast("Copying is not allowed here.", "error"),
    );
  });
  const clear = iconButton("trash", "Clear", () => {
    clearLog();
    full();
  });
  const close = iconButton("x", "Close (⇧⌘Y)", () => toggleConsole(false));

  const resize = h("div", { class: "console-resize", title: "Drag to resize", role: "separator", "aria-orientation": "horizontal" });
  const panel = h(
    "section",
    { class: "console", "aria-label": "Console", "aria-hidden": "true" },
    resize,
    h(
      "div",
      { class: "console-bar" },
      h("strong", null, "Console"),
      segmented,
      h("label", { class: "console-details" }, detailsBox, "Details"),
      h("div", { class: "console-search" }, search),
      count,
      h("span", { style: "flex:1" }),
      copy,
      clear,
      close,
    ),
    taskBox,
    list,
  );
  const height = savedHeight();
  if (height) panel.style.height = `${height}px`;
  // Toasts sit above the console rather than on top of it.
  const publishHeight = () =>
    document.documentElement.style.setProperty("--console-h", store.console.open ? `${Math.round(panel.getBoundingClientRect().height)}px` : "0px");

  const drawFilters = () =>
    segmented.replaceChildren(
      ...FILTERS.map(([key, label]) =>
        h(
          "button",
          {
            type: "button",
            role: "tab",
            "aria-selected": String(key === filter),
            class: key === filter ? "on" : "",
            onclick: () => {
              filter = key;
              drawFilters();
              full();
            },
          },
          label,
        ),
      ),
    );

  const matches = (e: LogEntry) => {
    if (!details && e.level === "debug") return false;
    if (filter !== "all") {
      const src = e.source === "files" || e.source === "ipc" ? "app" : e.source;
      if (src !== filter) return false;
    }
    if (query && !`${e.message} ${e.source} ${e.repoId ? repoName(e.repoId) : ""}`.toLowerCase().includes(query)) return false;
    return true;
  };
  const visible = () => entries.filter(matches);

  function row(e: LogEntry): HTMLElement {
    return h(
      "div",
      { class: `console-row lvl-${e.level}`, dataset: { id: String(e.id) } },
      h("time", null, timeLabel(e.time)),
      h("span", { class: "lvl", title: e.level }, e.level === "error" ? "ERR" : e.level === "warn" ? "WARN" : e.level === "debug" ? "·" : ""),
      h("span", { class: `src src-${e.source}` }, e.source),
      e.repoId ? h("span", { class: "repo" }, repoName(e.repoId)) : null,
      h("span", { class: "msg" }, e.message),
      e.count > 1 ? h("span", { class: "times" }, `×${e.count}`) : null,
    );
  }

  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 48;

  /** Everything again: a filter changed, or the log was cleared or trimmed. */
  function full() {
    const shown = visible().slice(-1500);
    list.replaceChildren(...shown.map(row));
    if (!shown.length) list.append(h("div", { class: "console-empty" }, entries.length ? "Nothing matches." : "Nothing has happened yet."));
    renderedUpTo = entries[entries.length - 1]?.id ?? 0;
    renderedKey = key();
    count.textContent = `${shown.length} line${shown.length === 1 ? "" : "s"}`;
    list.scrollTop = list.scrollHeight;
  }

  const key = () => `${filter}|${details}|${query}|${entries[0]?.id ?? 0}`;

  /** Only what arrived since the last paint, and the counts on repeats. */
  function incremental() {
    if (!store.console.open) return;
    if (key() !== renderedKey) return full();
    const stick = nearBottom();
    // A repeat updates its row's count in place.
    const lastRow = list.lastElementChild as HTMLElement | null;
    const lastShown = lastRow?.dataset.id ? entries.find((e) => e.id === Number(lastRow.dataset.id)) : undefined;
    if (lastRow && lastShown && lastShown.count > 1) lastRow.replaceWith(row(lastShown));
    const fresh = entries.filter((e) => e.id > renderedUpTo && matches(e));
    if (fresh.length) {
      list.querySelector(".console-empty")?.remove();
      list.append(...fresh.map(row));
      while (list.childElementCount > 1500) list.firstElementChild?.remove();
    }
    renderedUpTo = entries[entries.length - 1]?.id ?? renderedUpTo;
    count.textContent = `${list.querySelectorAll(".console-row").length} lines`;
    if (stick) list.scrollTop = list.scrollHeight;
  }

  function drawTasks() {
    const active = [...tasks.values()];
    taskBox.hidden = !active.length;
    taskBox.replaceChildren(
      ...active.map((t) => {
        const pct = t.total ? Math.min(100, Math.round((t.current / t.total) * 100)) : 0;
        return h(
          "div",
          { class: "console-task" },
          h("span", { class: "spinner" }),
          h("span", { class: "label" }, t.label, t.repoId ? h("span", { class: "repo" }, repoName(t.repoId)) : null),
          h("div", { class: "progress" }, h("div", { style: `width:${pct}%` })),
          h("span", { class: "nums" }, t.total ? `${t.current.toLocaleString()} / ${t.total.toLocaleString()} ${t.unit}` : "…"),
        );
      }),
    );
  }

  detailsBox.addEventListener("change", () => {
    details = detailsBox.checked;
    full();
  });
  search.addEventListener("input", () => {
    query = search.value.trim().toLowerCase();
    full();
  });
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      toggleConsole(false);
    }
  });

  // Drag the top edge to resize; remembered on this device.
  resize.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    resize.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = panel.getBoundingClientRect().height;
    panel.classList.add("resizing");
    const move = (ev: PointerEvent) => {
      const next = Math.max(120, Math.min(window.innerHeight * 0.85, startH + (startY - ev.clientY)));
      panel.style.height = `${next}px`;
    };
    const up = () => {
      resize.removeEventListener("pointermove", move);
      panel.classList.remove("resizing");
      publishHeight();
      try {
        localStorage.setItem(HEIGHT_KEY, String(Math.round(panel.getBoundingClientRect().height)));
      } catch {
        /* a private window: the height is just not remembered */
      }
    };
    resize.addEventListener("pointermove", move);
    resize.addEventListener("pointerup", up, { once: true });
  });

  on("log", () => {
    drawTasks();
    incremental();
  });
  on("console", () => {
    panel.classList.toggle("open", store.console.open);
    panel.setAttribute("aria-hidden", String(!store.console.open));
    publishHeight();
    if (store.console.open) {
      full();
      drawTasks();
      requestAnimationFrame(() => search.focus({ preventScroll: true }));
    }
  });
  on("repos", () => store.console.open && full());

  drawFilters();
  drawTasks();
  return panel;
}

function repoName(id: string): string {
  return repoById(id)?.name ?? id;
}

/** The button beside Settings: a badge for errors not yet seen, a pulse while
 *  something is in progress. */
export function consoleButton(): HTMLButtonElement {
  const badge = h("span", { class: "badge error", hidden: true });
  const btn = h("button", { class: "icon-btn console-btn", type: "button", title: "Console (⇧⌘Y)", "aria-label": "Console", onclick: () => toggleConsole() }, icon("terminal"), badge);
  const draw = () => {
    const n = unseenErrors();
    badge.hidden = n === 0;
    badge.textContent = n > 9 ? "9+" : String(n);
    btn.classList.toggle("on", store.console.open);
    btn.classList.toggle("working", tasks.size > 0 || Object.values(store.busy).some(Boolean));
  };
  on(["log", "console", "status"], draw);
  draw();
  return btn;
}
