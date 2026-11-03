import assert from "node:assert/strict";
import { test } from "node:test";
import { COLOR_MODES, colorModeOrDefault, DEFAULT_COLOR_MODE, isColorMode } from "@/domain/color-mode";

test("light is the default, and the three choices are light, dark and system", () => {
  assert.equal(DEFAULT_COLOR_MODE, "light");
  assert.deepEqual([...COLOR_MODES], ["light", "dark", "system"]);
});

test("a stored choice is kept; anything else (no session, an unknown value) falls back to light", () => {
  for (const mode of COLOR_MODES) assert.equal(colorModeOrDefault(mode), mode);
  for (const value of [undefined, null, "", "Dark", "auto", 1, {}]) {
    assert.equal(colorModeOrDefault(value), "light", String(value));
    assert.equal(isColorMode(value), false);
  }
});
