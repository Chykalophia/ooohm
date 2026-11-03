import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_APPEARANCE, THEME_KEYS, followsDarkMode, normalizeAppearance, readAppearance } from "@/domain/appearance";
import { isDomainError } from "@/domain/errors";
import { DARKEST_LIGHT_GROUND, accentTokens, htmlAppearance } from "@/lib/appearance";
import { contrastRatio } from "@/lib/color";
import type { ServiceContext } from "@/server/context";
import { getAppearance } from "@/server/services/appearance";

const invalid = (fn: () => unknown) => assert.throws(fn, (err) => isDomainError(err, "invalid_input"));

test("appearance: known themes and corners pass, the accent is normalized or cleared", () => {
  assert.deepEqual(normalizeAppearance({ theme: "cobalt", accentColor: "#C4220F", corners: "square" }), {
    theme: "cobalt",
    accentColor: "#c4220f",
    corners: "square",
  });
  assert.equal(normalizeAppearance({ theme: "plum", accentColor: "#abc", corners: "theme" }).accentColor, "#aabbcc");
  assert.equal(normalizeAppearance({ theme: "plum", accentColor: "  ", corners: "theme" }).accentColor, null);
  assert.equal(normalizeAppearance({ theme: "plum", accentColor: null, corners: "theme" }).accentColor, null);
  assert.equal(
    normalizeAppearance({ theme: "classic", accentColor: "#0F766E", corners: "theme" }).accentColor,
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
});

test("appearance: a stored value this version does not know falls back instead of failing", () => {
  assert.deepEqual(readAppearance({ theme: "from-the-future", accentColor: "nope", corners: "theme" }), DEFAULT_APPEARANCE);
  assert.deepEqual(readAppearance({ theme: "forest", accentColor: "#zzz", corners: "round" }), {
    theme: "forest",
    accentColor: null,
    corners: "round",
  });
  assert.deepEqual(
    readAppearance({ theme: "from-the-future", accentColor: "#F2A900", corners: "wobbly" }),
    { theme: "classic", accentColor: "#f2a900", corners: "theme" },
    "an unknown theme or corner style keeps a valid accent",
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

test("html appearance: attributes for the stylesheet, accent tokens only when customised", () => {
  assert.deepEqual(htmlAppearance(DEFAULT_APPEARANCE), { attributes: { "data-ui": "classic", "data-scheme": "auto" }, style: {} });
  const custom = htmlAppearance({ theme: "graphite", accentColor: "#f2a900", corners: "round" });
  assert.deepEqual(custom.attributes, { "data-ui": "graphite", "data-corners": "round" });
  assert.equal(custom.style["--accent"], "#f2a900");
  assert.equal(custom.style["--accent-foreground"], "#111111");
  assert.ok(custom.style["--accent-ink"]);
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
