import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_APPEARANCE, THEME_KEYS, followsDarkMode, normalizeAppearance, readAppearance } from "@/domain/appearance";
import { isDomainError } from "@/domain/errors";
import { DARKEST_LIGHT_GROUND, accentHover, accentTokens, htmlAppearance } from "@/lib/appearance";
import { contrastRatio } from "@/lib/color";
import type { ServiceContext } from "@/server/context";
import { getAppearance } from "@/server/services/appearance";

const invalid = (fn: () => unknown) => assert.throws(fn, (err) => isDomainError(err, "invalid_input"));

test("appearance: known themes and corners pass, the accent is normalized or cleared", () => {
  assert.deepEqual(normalizeAppearance({ theme: "cobalt", accentColor: "#C4220F", corners: "square" }), {
    theme: "cobalt",
    accentColor: "#c4220f",
    corners: "square",
    requestStyle: "form",
    layout: "standard",
  });
  assert.equal(normalizeAppearance({ theme: "plum", corners: "theme", layout: "compact" }).layout, "compact");
  assert.equal(normalizeAppearance({ theme: "plum", corners: "theme", requestStyle: "sentence" }).requestStyle, "sentence");
  assert.equal(normalizeAppearance({ theme: "plum", accentColor: "#abc", corners: "theme" }).accentColor, "#aabbcc");
  assert.equal(normalizeAppearance({ theme: "plum", accentColor: "  ", corners: "theme" }).accentColor, null);
  assert.equal(normalizeAppearance({ theme: "plum", accentColor: null, corners: "theme" }).accentColor, null);
  assert.equal(
    normalizeAppearance({ theme: "classic", accentColor: "#115E59", corners: "theme" }).accentColor,
    null,
    "the theme's own accent is no custom accent, so Classic keeps dark mode",
  );
  assert.equal(THEME_KEYS[0], "classic");
});

test("appearance: unknown themes, corners and colours are refused", () => {
  invalid(() => normalizeAppearance({ theme: "neon", corners: "theme" }));
  invalid(() => normalizeAppearance({ theme: "toString", corners: "theme" }));
  invalid(() => normalizeAppearance({ theme: "classic", corners: "wobbly" }));
  invalid(() => normalizeAppearance({ theme: "classic", corners: "theme", accentColor: "teal" }));
  invalid(() => normalizeAppearance({ theme: "classic", corners: "theme", accentColor: "#12345" }));
  invalid(() => normalizeAppearance({ theme: "classic", corners: "theme", requestStyle: "wizard" }));
  invalid(() => normalizeAppearance({ theme: "classic", corners: "theme", layout: "toString" }));
});

test("appearance: a stored value this version does not know falls back instead of failing", () => {
  assert.deepEqual(
    readAppearance({ theme: "from-the-future", accentColor: "nope", corners: "theme", requestStyle: "voice", layout: "holo" }),
    DEFAULT_APPEARANCE,
  );
  assert.deepEqual(readAppearance({ theme: "forest", accentColor: "#zzz", corners: "round", requestStyle: "sentence", layout: "legible" }), {
    theme: "forest",
    accentColor: null,
    corners: "round",
    requestStyle: "sentence",
    layout: "legible",
  });
  assert.deepEqual(
    readAppearance({ theme: "from-the-future", accentColor: "#F2A900", corners: "wobbly", requestStyle: "form", layout: "standard" }),
    { theme: "classic", accentColor: "#f2a900", corners: "theme", requestStyle: "form", layout: "standard" },
    "an unknown theme or corner style keeps a valid accent",
  );
  assert.deepEqual(
    readAppearance({ theme: "plum", accentColor: "#2546d0", corners: "round", requestStyle: "sentence", layout: "holo" }),
    { theme: "plum", accentColor: "#2546d0", corners: "round", requestStyle: "sentence", layout: "standard" },
    "an unknown layout falls back on its own",
  );
});

test("appearance: only Classic with its own accent follows dark mode", () => {
  assert.equal(followsDarkMode(DEFAULT_APPEARANCE), true);
  assert.equal(followsDarkMode({ ...DEFAULT_APPEARANCE, accentColor: "#ff0000" }), false);
  assert.equal(followsDarkMode({ ...DEFAULT_APPEARANCE, theme: "cobalt" }), false);
});

test("accent tokens: text on the fill and accent-coloured text both stay readable", () => {
  for (const color of ["#f2a900", "#ffeb3b", "#2546d0", "#000000", "#ffffff", "#7f7f7f", "#838383", "#777777", "#767676"]) {
    const t = accentTokens(color);
    assert.ok(contrastRatio(t.accent, t.accentForeground) >= 4.5, `${color}: label on the fill`);
    assert.ok(contrastRatio(t.accentInk, "#ffffff") >= 4.5, `${color}: ink on white`);
    assert.ok(contrastRatio(t.accentInk, DARKEST_LIGHT_GROUND) >= 4.5, `${color}: ink on the darkest theme ground`);
  }
  assert.equal(accentTokens("#2546d0").accentInk, "#2546d0", "a dark accent is its own ink");
  assert.equal(accentTokens("#f2a900").accentForeground, "#111111", "a pale accent gets dark text");
});

test("accent hover: the main button's label keeps 4.5:1 and the fill visibly changes, for any custom accent", () => {
  const colors = ["#f2a900", "#ffeb3b", "#2546d0", "#000000", "#ffffff", "#7f7f7f", "#777777", "#767676", "#18181b", "#fafafa"];
  for (let i = 0; i < 64; i++) colors.push(`#${((i * 2654435761) >>> 8).toString(16).padStart(6, "0").slice(0, 6)}`);
  for (const color of colors) {
    const t = accentTokens(color);
    assert.ok(contrastRatio(t.accentHover, t.accentForeground) >= 4.5, `${color}: label on the hover fill`);
    assert.notEqual(t.accentHover, t.accent, `${color}: hover differs from the fill`);
  }
  assert.equal(accentHover("#e0301e", "#ffffff"), "#ca2b1b", "white text: the fill darkens");
  assert.equal(accentHover("#f2a900", "#14213d"), "#f3b21a", "dark text: the fill lightens");
  assert.equal(accentHover("#18181b", "#ffffff"), "#2f2f32", "a near-black fill lightens, since darker would not show");
});

test("accent hover: every theme's --accent-hover in globals.css follows the rule and keeps 4.5:1", () => {
  const css = readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8");
  const blocks = [...css.matchAll(/\[data-ui="([a-z]+)"\] \{([^}]*)\}/g)].filter(([, , body]) => body.includes("--accent:"));
  assert.deepEqual(blocks.map(([, theme]) => theme).sort(), [...THEME_KEYS].sort(), "one accent block per theme");
  for (const [, theme, body] of blocks) {
    const token = (name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(body)?.[1]?.trim() ?? "";
    // Classic writes light-dark() pairs; check each half.
    const halves = (v: string) => (v.startsWith("light-dark(") ? v.slice(11, -1).split(",").map((s) => s.trim()) : [v]);
    const [accents, foregrounds, hovers] = ["accent", "accent-foreground", "accent-hover"].map((n) => halves(token(n)));
    assert.equal(hovers.length, accents.length, `${theme}: --accent-hover is set`);
    accents.forEach((accent, i) => {
      assert.equal(hovers[i], accentHover(accent, foregrounds[i]), `${theme}[${i}]: matches accentHover()`);
      assert.ok(contrastRatio(hovers[i], foregrounds[i]) >= 4.5, `${theme}[${i}]: label on the hover fill`);
    });
  }
});

test("html appearance: attributes for the stylesheet, accent tokens only when customised", () => {
  assert.deepEqual(htmlAppearance(DEFAULT_APPEARANCE), { attributes: { "data-ui": "classic", "data-mode": "light" }, style: {} });
  const custom = htmlAppearance({ theme: "graphite", accentColor: "#f2a900", corners: "round" }, "dark");
  assert.deepEqual(custom.attributes, { "data-ui": "graphite", "data-corners": "round", "data-mode": "light" }, "a light-only look stays light");
  assert.equal(htmlAppearance({ ...DEFAULT_APPEARANCE, layout: "compact" }).attributes["data-layout"], "compact");
  assert.equal(htmlAppearance(DEFAULT_APPEARANCE).attributes["data-layout"], undefined);
  assert.equal(custom.style["--accent"], "#f2a900");
  assert.equal(custom.style["--accent-foreground"], "#111111");
  assert.ok(custom.style["--accent-ink"]);
  assert.equal(custom.style["--accent-hover"], accentTokens("#f2a900").accentHover);
});

test("get appearance: a failed read falls back to the default look instead of failing the page", async () => {
  const broken = {
    db: {
      select() {
        throw new Error("database unreachable");
      },
    },
  } as unknown as ServiceContext;
  assert.deepEqual(await getAppearance(broken), DEFAULT_APPEARANCE);
});

test("html appearance: the person's colour mode applies only where the theme has a dark version", () => {
  for (const mode of ["light", "dark", "system"] as const) {
    assert.equal(htmlAppearance(DEFAULT_APPEARANCE, mode).attributes["data-mode"], mode, `classic, ${mode}`);
    assert.equal(htmlAppearance({ ...DEFAULT_APPEARANCE, theme: "cobalt" }, mode).attributes["data-mode"], "light", `cobalt, ${mode}`);
    assert.equal(htmlAppearance({ ...DEFAULT_APPEARANCE, accentColor: "#ff0000" }, mode).attributes["data-mode"], "light", `classic with a custom accent, ${mode}`);
  }
});
