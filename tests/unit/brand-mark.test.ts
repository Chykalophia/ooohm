import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_APPEARANCE, THEME_KEYS, THEMES } from "@/domain/appearance";
import {
  CLASSIC_DARK_MARK,
  DARK_TAB,
  appearanceAccent,
  appearanceDarkMark,
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
  assert.equal(appearanceDarkMark(DEFAULT_APPEARANCE), CLASSIC_DARK_MARK);
  assert.equal(appearanceDarkMark({ ...DEFAULT_APPEARANCE, accentColor: "#123456" }), null);
  assert.equal(appearanceDarkMark({ ...DEFAULT_APPEARANCE, theme: "plum" }), null);
  assert.match(
    faviconSvg(THEMES.classic.accent, CLASSIC_DARK_MARK),
    /prefers-color-scheme:dark\)\{\.t\{fill:#2dd4bf\}\.m\{stroke:#042f2e\}/,
  );
});

test("brand mark: Classic's dark favicon colours match the dark accent in globals.css", () => {
  const css = readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8");
  // Classic writes each colour as a light-dark() pair; the dark mode's is the second.
  const darkOf = (name: string) => new RegExp(`${name}:\\s*light-dark\\([^,]+,\\s*([^)]+)\\);`).exec(css)?.[1]?.trim();
  assert.equal(darkOf("--accent"), CLASSIC_DARK_MARK.tile);
  assert.equal(darkOf("--accent-foreground"), CLASSIC_DARK_MARK.mark);
});

test("brand mark: only #rrggbb colours reach the SVG, whatever is passed in", () => {
  const hostile = '#000}</style><script>alert(1)</script><style>{';
  for (const svg of [
    faviconSvg(hostile),
    faviconSvg("red;}.t{fill:url(javascript:alert(1))"),
    faviconSvg(THEMES.classic.accent, { tile: hostile, mark: "expression(alert(1))" }),
  ]) {
    assert.doesNotMatch(svg, /script|javascript|expression|alert/i);
    const style = /<style>(.*)<\/style>/.exec(svg)?.[1];
    assert.ok(style, "favicon SVG has a <style> block");
    for (const value of style.match(/(?<=(fill|stroke):)[^}]*/g) ?? []) assert.match(value, /^#[0-9a-f]{6}$/);
  }
  // Anything that is not a hex colour falls back to the default accent.
  assert.match(faviconSvg(hostile), new RegExp(`\\.t\\{fill:${THEMES.classic.accent}\\}`));
});
