import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_APPEARANCE, THEME_KEYS, THEMES } from "@/domain/appearance";
import { DARK_TAB, appearanceAccent, darkMarkColors, faviconSvg, markColors } from "@/lib/brand-mark";
import { contrastRatio } from "@/lib/color";

test("brand mark: the favicon takes the theme's accent, or the admin's own colour", () => {
  assert.equal(appearanceAccent(DEFAULT_APPEARANCE), THEMES.classic.accent);
  assert.equal(appearanceAccent({ ...DEFAULT_APPEARANCE, theme: "plum" }), THEMES.plum.accent);
  assert.equal(appearanceAccent({ ...DEFAULT_APPEARANCE, theme: "plum", accentColor: "#ABC" }), "#aabbcc");
  assert.match(faviconSvg(THEMES.cobalt.accent), /\.t\{fill:#2546d0\}/);
});

test("brand mark: every theme's Ω reads on its tile, and the tile stands apart from a dark tab bar", () => {
  for (const key of THEME_KEYS) {
    const accent = THEMES[key].accent;
    for (const { tile, mark } of [markColors(accent), darkMarkColors(accent)]) {
      assert.ok(contrastRatio(tile, mark) >= 3, `${key}: Ω on tile`);
    }
    assert.ok(contrastRatio(darkMarkColors(accent).tile, DARK_TAB) >= 2, `${key}: tile on a dark tab`);
  }
});

test("brand mark: a dark-mode variant appears only when the tile needs lifting", () => {
  assert.doesNotMatch(faviconSvg(THEMES.classic.accent), /prefers-color-scheme/);
  assert.match(faviconSvg(THEMES.graphite.accent), /prefers-color-scheme:dark/);
});
