// Settings: a sidebar of sections — Appearance, GitHub, AI, Shortcuts — and
// the page for whichever is chosen. Changes apply as they are made and are
// saved a moment later; secrets go straight to the Rust side and only their
// existence comes back.

import { h, icon, keyLabel } from "../lib/dom";
import { api, openExternal } from "../lib/ipc";
import { emit, store } from "../lib/store";
import * as actions from "../lib/actions";
import { applyAppearance, FONTS } from "../lib/theme";
import { APP_SHORTCUTS, HUSH_SHORTCUTS, type Shortcut } from "../editor/keymap";
import { openModal } from "./modal";
import { toast } from "./toast";

type Section = "appearance" | "github" | "ai" | "shortcuts";

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function changed() {
  applyAppearance(store.settings.appearance);
  emit("settings");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void actions.saveSettings(), 400);
}

export function openSettings(section: Section = "appearance") {
  if (document.querySelector(".settings.modal-overlay")) return;
  let current: Section = section;
  const page = h("div", { class: "settings-page" });
  const nav = h("nav", { class: "settings-nav", "aria-label": "Settings sections" });
  const sections: [Section, string, string][] = [
    ["appearance", "Appearance", "type"],
    ["github", "GitHub", "github"],
    ["ai", "AI", "sparkle"],
    ["shortcuts", "Shortcuts", "keyboard"],
  ];

  openModal({
    title: "Settings",
    className: "settings",
    custom: (close) => {
      const draw = () => {
        nav.replaceChildren(
          h("h3", null, "Settings"),
          ...sections.map(([key, label, ic]) =>
            h("button", { type: "button", class: key === current ? "on" : "", onclick: () => ((current = key), draw()) }, icon(ic), label),
          ),
        );
        const closeBtn = h("button", { class: "icon-btn settings-close", type: "button", "aria-label": "Close", onclick: close }, icon("x"));
        const content = current === "appearance" ? appearance() : current === "github" ? github(draw) : current === "ai" ? ai(draw) : shortcuts();
        page.replaceChildren(closeBtn, content);
      };
      draw();
      return h("div", { class: "settings-layout" }, nav, page);
    },
  });
}

// ── controls ────────────────────────────────────────────────────────────────

function opt(title: string, sub: string | null, ...trail: (Node | null)[]): HTMLElement {
  return h("div", { class: "opt" }, h("div", { class: "lead" }, h("div", { class: "t" }, title), sub ? h("div", { class: "s" }, sub) : null), h("div", { class: "trail" }, ...trail));
}

function segmented<T extends string>(value: T, options: [T, string][], onChange: (v: T) => void): HTMLElement {
  const el = h("div", { class: "segmented", role: "radiogroup" });
  const draw = (v: T) =>
    el.replaceChildren(
      ...options.map(([key, label]) =>
        h("button", { type: "button", role: "radio", "aria-checked": String(key === v), class: key === v ? "on" : "", onclick: () => (onChange(key), draw(key)) }, label),
      ),
    );
  draw(value);
  return el;
}

function toggle(value: boolean, onChange: (v: boolean) => void): HTMLInputElement {
  const el = h("input", { type: "checkbox", class: "switch", checked: value });
  el.addEventListener("change", () => onChange(el.checked));
  return el;
}

function slider(value: number, min: number, max: number, step: number, format: (v: number) => string, onChange: (v: number) => void): HTMLElement[] {
  const out = h("span", { class: "value" }, format(value));
  const input = h("input", { type: "range", min, max, step, value: String(value), style: "width:160px" });
  input.addEventListener("input", () => {
    const v = Number(input.value);
    out.textContent = format(v);
    onChange(v);
  });
  return [input, out];
}

// ── pages ───────────────────────────────────────────────────────────────────

function appearance(): HTMLElement {
  const a = store.settings.appearance;
  const custom = h("input", { class: "input", value: a.customFont, placeholder: "e.g. Charter, Literata", style: "width:200px" });
  custom.addEventListener("input", () => {
    a.customFont = custom.value;
    changed();
  });
  const customRow = opt("Font name", "Any font installed on this device.", custom);
  customRow.hidden = a.font !== "custom";
  const font = h(
    "select",
    { class: "select", style: "width:230px" },
    FONTS.map((f) => h("option", { value: f.key, selected: f.key === a.font }, f.label)),
  );
  font.addEventListener("change", () => {
    a.font = font.value;
    customRow.hidden = a.font !== "custom";
    changed();
  });

  return h(
    "div",
    null,
    h("h4", null, "Appearance"),
    h("p", { class: "lede" }, "How the text column looks. Changes show as you make them."),
    h(
      "div",
      { class: "font-sample" },
      h("div", { style: "font-weight:700;font-size:1.3em;margin-bottom:.3em" }, "# The right spoon"),
      "There is a particular pleasure in finding the ",
      h("em", null, "right"),
      " tool for a small job, and then forgetting about it entirely.",
    ),
    h("div", { class: "group-title" }, "Theme"),
    h(
      "div",
      { class: "group" },
      opt("Appearance", "System follows the device's light or dark setting.", segmented(a.theme, [["system", "System"], ["light", "Light"], ["dark", "Dark"]], (v) => ((a.theme = v), changed()))),
    ),
    h("div", { class: "group-title" }, "Text"),
    h(
      "div",
      { class: "group" },
      opt("Font", null, font),
      customRow,
      opt("Size", null, ...slider(a.fontSize, 12, 30, 1, (v) => `${v}px`, (v) => ((a.fontSize = v), changed()))),
      opt("Line height", null, ...slider(a.lineHeight, 1.2, 2.2, 0.05, (v) => v.toFixed(2), (v) => ((a.lineHeight = v), changed()))),
      opt("Column width", "The text column's widest measure, in characters.", ...slider(a.columnWidth, 40, 120, 2, (v) => `${v} ch`, (v) => ((a.columnWidth = v), changed()))),
    ),
    h("div", { class: "group-title" }, "Markdown"),
    h(
      "div",
      { class: "group" },
      opt("Frontmatter", "The YAML or TOML block at the top of a post.", segmented(a.frontmatter, [["dim", "Dim"], ["fold", "Fold"], ["show", "Show"]], (v) => ((a.frontmatter = v), changed()))),
      opt("Inline images", "Show images under the line that names them, found through the site structure.", toggle(a.inlineImages, (v) => ((a.inlineImages = v), changed()))),
      opt("Spell check", null, toggle(a.spellcheck, (v) => ((a.spellcheck = v), changed()))),
    ),
  );
}

function github(redraw: () => void): HTMLElement {
  const s = store.secrets;
  const g = store.settings.git;
  const token = h("input", { class: "input mono", type: "password", placeholder: "github_pat_…", autocomplete: "off", spellcheck: false });
  const message = h("div");
  const signIn = h("button", { class: "btn primary", type: "button" }, "Verify & save");
  signIn.addEventListener("click", async () => {
    signIn.disabled = true;
    message.replaceChildren(h("div", { class: "notice info", style: "margin-top:8px" }, "Checking with GitHub…"));
    try {
      store.secrets = await api.githubSignIn(token.value);
      emit("secrets");
      toast(`Signed in as ${store.secrets.githubLogin}.`);
      redraw();
    } catch (e) {
      message.replaceChildren(h("div", { class: "notice error", style: "margin-top:8px" }, (e as Error).message));
      signIn.disabled = false;
    }
  });
  token.addEventListener("keydown", (e) => e.key === "Enter" && signIn.click());

  const text = (value: string, placeholder: string, set: (v: string) => void, width = "220px") => {
    const el = h("input", { class: "input", value, placeholder, style: `width:${width}` });
    el.addEventListener("input", () => (set(el.value), changed()));
    return el;
  };

  const account = s.hasGithubToken
    ? h(
        "div",
        { class: "group" },
        opt(
          `Signed in as ${s.githubLogin || "(unknown)"}`,
          "The token is kept on this device and used only for git and GitHub's API. It is never shown again.",
          h(
            "button",
            {
              class: "btn",
              type: "button",
              onclick: async () => {
                store.secrets = await api.githubSignOut();
                emit("secrets");
                redraw();
              },
            },
            "Sign out",
          ),
        ),
      )
    : h(
        "div",
        { class: "group" },
        h(
          "div",
          { class: "opt stack" },
          h(
            "div",
            { class: "lead" },
            h("div", { class: "t" }, "Personal access token"),
            h(
              "div",
              { class: "s" },
              "A fine-grained token with ",
              h("b", null, "Contents: Read and write"),
              " on the repositories you edit (Metadata: read is added automatically; Pages: read lets the app find a custom domain). Public repositories clone without one, but pushing needs it. ",
              h("button", { class: "link", type: "button", onclick: () => void openExternal("https://github.com/settings/personal-access-tokens/new") }, "Create a token on GitHub"),
            ),
          ),
          h("div", { class: "row" }, h("div", { class: "grow" }, token), signIn),
          message,
        ),
      );

  return h(
    "div",
    null,
    h("h4", null, "GitHub"),
    h("p", { class: "lede" }, "Signing in is needed for private repositories and for pushing. Everything else — editing, committing, switching branches — works offline."),
    h("div", { class: "group-title" }, "Account"),
    account,
    h("div", { class: "group-title" }, "Commits"),
    h(
      "div",
      { class: "group" },
      opt("Author name", "Blank uses your GitHub login.", text(g.authorName, s.githubLogin || "Your name", (v) => (g.authorName = v))),
      opt("Author email", "Blank uses GitHub's no-reply address, so no email is published.", text(g.authorEmail, s.githubLogin ? `${s.githubLogin}@users.noreply.github.com` : "you@users.noreply.github.com", (v) => (g.authorEmail = v), "260px")),
      opt("Message", "{files} becomes the changed posts' titles.", text(g.commitTemplate, "Update {files}", (v) => (g.commitTemplate = v))),
      opt("Push after committing", "Commit & Push becomes the default button.", toggle(g.pushAfterCommit, (v) => ((g.pushAfterCommit = v), changed()))),
      opt("Check GitHub when a repository opens", "Fetches only; nothing is merged until you pull.", toggle(g.fetchOnOpen, (v) => ((g.fetchOnOpen = v), changed()))),
    ),
  );
}

function ai(redraw: () => void): HTMLElement {
  const a = store.settings.ai;
  return h(
    "div",
    null,
    h("h4", null, "AI"),
    h(
      "p",
      { class: "lede" },
      "Optional. When a site's config is too unusual to read by rule, the provider chosen here works out its structure — which folders hold posts, what URL each is published at, and where its images live — so inline images, the draft preview and “Edit this post” are right. ",
      "Only the repository's file listing, its config files and the first lines of a few posts are sent, and only when you ask.",
    ),
    h("div", { class: "group-title" }, "Provider"),
    h(
      "div",
      { class: "group" },
      opt("Use", null, segmented(a.provider, [["none", "None"], ["anthropic", "Anthropic"], ["openai", "OpenAI"]], (v) => ((a.provider = v), changed(), redraw()))),
    ),
    providerCard("anthropic", "Anthropic", "sk-ant-…", store.secrets.hasAnthropicKey, a.anthropicModel, (m) => (a.anthropicModel = m), redraw, "https://console.anthropic.com/settings/keys"),
    providerCard("openai", "OpenAI", "sk-…", store.secrets.hasOpenaiKey, a.openaiModel, (m) => (a.openaiModel = m), redraw, "https://platform.openai.com/api-keys"),
  );
}

const modelCache: Record<string, string[]> = {};

function providerCard(
  provider: "anthropic" | "openai",
  label: string,
  placeholder: string,
  hasKey: boolean,
  model: string,
  setModel: (m: string) => void,
  redraw: () => void,
  keysUrl: string,
): HTMLElement {
  const key = h("input", { class: "input mono", type: "password", placeholder: hasKey ? "A key is saved — paste a new one to replace it" : placeholder, autocomplete: "off", spellcheck: false });
  const result = h("div");
  const models = modelCache[provider] ?? [];
  const select = h(
    "select",
    { class: "select", style: "width:240px", disabled: !models.length && !model },
    (models.length ? models : model ? [model] : ["Test the key to list models"]).map((m) => h("option", { value: m, selected: m === model }, m)),
  );
  select.addEventListener("change", () => (setModel(select.value), changed()));

  const save = h("button", { class: "btn", type: "button" }, "Save key");
  save.addEventListener("click", async () => {
    if (!key.value.trim()) return;
    try {
      store.secrets = await api.setAiKey(provider, key.value);
      emit("secrets");
      key.value = "";
      await test();
    } catch (e) {
      result.replaceChildren(h("div", { class: "notice error" }, (e as Error).message));
    }
  });
  const testBtn = h("button", { class: "btn", type: "button", disabled: !hasKey, onclick: () => void test() }, "Test");
  const remove = h(
    "button",
    {
      class: "btn quiet danger",
      type: "button",
      hidden: !hasKey,
      onclick: async () => {
        store.secrets = await api.setAiKey(provider, "");
        emit("secrets");
        redraw();
      },
    },
    "Remove",
  );

  async function test() {
    result.replaceChildren(h("div", { class: "notice info" }, h("span", { class: "spinner", style: "margin-right:8px;vertical-align:-2px" }), "Testing…"));
    try {
      const t = await api.testAiKey(provider);
      modelCache[provider] = t.models;
      const current = provider === "anthropic" ? store.settings.ai.anthropicModel : store.settings.ai.openaiModel;
      if (!current || !t.models.includes(current)) {
        const preferred = provider === "anthropic" ? ["claude-opus-5-5"] : ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-5.6-sol"];
        const pick = preferred.find((p) => t.models.includes(p)) ?? t.models[0] ?? current;
        if (pick) {
          setModel(pick);
          changed();
        }
      }
      redraw();
      toast(`${label}: ${t.message}`);
    } catch (e) {
      result.replaceChildren(h("div", { class: "notice error" }, (e as Error).message));
    }
  }

  return h(
    "div",
    null,
    h("div", { class: "group-title" }, label),
    h(
      "div",
      { class: "group" },
      h(
        "div",
        { class: "opt stack" },
        h(
          "div",
          { class: "lead" },
          h("div", { class: "t" }, hasKey ? "API key saved" : "API key"),
          h("div", { class: "s" }, "Kept on this device; requests are made from the app, never from the page. ", h("button", { class: "link", type: "button", onclick: () => void openExternal(keysUrl) }, `Get ${/^[AEIOU]/.test(label) ? "an" : "a"} ${label} key`)),
        ),
        h("div", { class: "row" }, h("div", { class: "grow" }, key), save, testBtn, remove),
        result,
      ),
      opt("Model", provider === "anthropic" ? "Defaults to Claude Opus 5.5." : "Chosen from the models your key can use.", select),
    ),
  );
}

function shortcuts(): HTMLElement {
  const groups = new Map<string, Shortcut[]>();
  for (const s of [...HUSH_SHORTCUTS, ...APP_SHORTCUTS]) {
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group)!.push(s);
  }
  return h(
    "div",
    null,
    h("h4", null, "Shortcuts"),
    h("p", { class: "lede" }, "The text-editing shortcuts are hush's, with hush's keys."),
    [...groups.entries()].map(([group, list]) => [
      h("div", { class: "group-title" }, group),
      h("div", { class: "group" }, h("table", { class: "shortcut-table" }, list.map((s) => h("tr", null, h("td", null, s.label), h("td", null, h("span", { class: "kbd" }, s.key === "Alt-click" ? "⌥ click" : keyLabel(s.key))))))),
    ]),
  );
}
