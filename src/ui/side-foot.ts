// The footer under the two side columns: Settings, night vision, the console
// and the offline pill. It spans the repositories and Files columns and
// narrows to the Files column when the repositories are hidden, so these
// stay in reach whichever side columns are showing.

import { h, icon, iconButton } from "../lib/dom";
import { on, store } from "../lib/store";
import * as actions from "../lib/actions";
import { log } from "../lib/log";
import { openSettings } from "./settings";
import { consoleButton } from "./console";

/** Night vision on or off, from the button here or from Settings. */
export function setNightVision(active: boolean) {
  store.settings.appearance.nightVision = active;
  void actions.saveSettings();
}

function nightButton(): HTMLButtonElement {
  const btn = iconButton("night", "Night vision", () => setNightVision(!store.settings.appearance.nightVision));
  const draw = () => {
    const active = !!store.settings.appearance.nightVision;
    btn.classList.toggle("on", active);
    btn.setAttribute("aria-pressed", String(active));
    btn.title = active ? "Night vision is on: press for colour" : "Night vision: red only, no blue light";
  };
  on("settings", draw);
  draw();
  return btn;
}

export function sideFooter(): HTMLElement {
  const offline = h("span", { class: "pill warn", hidden: true, title: "Editing and committing work offline. Pull and push wait for the network." }, icon("cloudoff", 12), "Offline");
  const draw = () => (offline.hidden = store.online);
  window.addEventListener("online", () => {
    store.online = true;
    log.info("app", "Back online");
    draw();
  });
  window.addEventListener("offline", () => {
    store.online = false;
    log.warn("app", "Offline — editing and committing carry on; pull and push wait for the network");
    draw();
  });
  draw();
  return h(
    "footer",
    { class: "side-foot" },
    iconButton("gear", "Settings (⌘,)", () => openSettings()),
    nightButton(),
    consoleButton(),
    h("span", { style: "flex:1" }),
    offline,
  );
}
