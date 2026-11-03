import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_APPEARANCE, THEME_KEYS, THEMES } from "@/domain/appearance";
import {
  CLASSIC_DARK_ACCENT,
  DARK_TAB,
  appearanceAccent,
  appearanceDarkAccent,
  darkMarkColors,
  faviconSvg,
  markColors,
} from "@/lib/brand-mark";
import { contrastRatio } from "@/lib/color";

test("brand mark: the favicon takes the theme's accent, or the admin's own colour", () => {
  assert.equal(appearanceAccent(DEFAULT_APPEARANCE), THEMES.classic.accent);
  assert.equal(appearanceAccent({ ...DEFAULT_APPEARANCE, theme: "plum" }), THEMES.plum.accent);
  assert.equal(appearanceAccent({ ...DEFAULT_APPEARANCE, theme: "plum", accentColor: "#ABC" }), "#aabbcc");
  assert.match(faviconSvg(THEMES.cobalt.accent), /\.t\{fill:#2546d0\}/);
});

test("brand mark: the Ω reads on its tile, and the tile reaches 3:1 on a dark tab bar, for themes and custom colours", () => {
  const custom = ["#000000", "#ffffff", "#fff3a0", "#777777", "#18181b", "#c4220f"];
  for (const accent of [...THEME_KEYS.map((k) => THEMES[k].accent), ...custom]) {
    for (const { tile, mark } of [markColors(accent), darkMarkColors(accent)]) {
      assert.ok(contrastRatio(tile, mark) >= 3, `${accent}: Ω on tile`);
    }
    assert.ok(contrastRatio(darkMarkColors(accent).tile, DARK_TAB) >= 3, `${accent}: tile on a dark tab`);
  }
});

test("brand mark: a dark-mode variant appears when the tile needs lifting or the theme has a dark accent", () => {
  assert.doesNotMatch(faviconSvg(THEMES.signal.accent), /prefers-color-scheme/);
  assert.match(faviconSvg(THEMES.graphite.accent), /prefers-color-scheme:dark/);
  assert.equal(appearanceDarkAccent(DEFAULT_APPEARANCE), CLASSIC_DARK_ACCENT);
  assert.equal(appearanceDarkAccent({ ...DEFAULT_APPEARANCE, accentColor: "#123456" }), null);
  assert.equal(appearanceDarkAccent({ ...DEFAULT_APPEARANCE, theme: "plum" }), null);
  assert.match(faviconSvg(THEMES.classic.accent, CLASSIC_DARK_ACCENT), /prefers-color-scheme:dark\)\{\.t\{fill:#2dd4bf\}/);
});
