import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_THEME, THEMES, isTheme, themeOrDefault } from "@/domain/theme";

test("light is the default, and the three choices are light, dark and system", () => {
  assert.equal(DEFAULT_THEME, "light");
  assert.deepEqual([...THEMES], ["light", "dark", "system"]);
});

test("a stored choice is kept; anything else (no session, an unknown value) falls back to light", () => {
  for (const theme of THEMES) assert.equal(themeOrDefault(theme), theme);
  for (const value of [undefined, null, "", "Dark", "auto", 1, {}]) {
    assert.equal(themeOrDefault(value), "light", String(value));
    assert.equal(isTheme(value), false);
  }
});
