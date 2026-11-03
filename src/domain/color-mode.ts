/**
 * Light or dark: how a person wants the app drawn (their "colour mode"; the company's
 * look, its theme, is `@/domain/appearance`). A display preference of their own: it changes
 * nothing anyone else sees, so it is neither audited nor sent to integrations.
 *
 * - `light`: the default, for everyone until they choose otherwise.
 * - `dark`: always dark.
 * - `system`: follows the device's light or dark setting, and switches with it.
 */
export const COLOR_MODES = ["light", "dark", "system"] as const;

export type ColorMode = (typeof COLOR_MODES)[number];

export const DEFAULT_COLOR_MODE: ColorMode = "light";

export function isColorMode(value: unknown): value is ColorMode {
  return typeof value === "string" && (COLOR_MODES as readonly string[]).includes(value);
}

/** The stored preference, or the default for anything else (no session, an unknown value). */
export function colorModeOrDefault(value: unknown): ColorMode {
  return isColorMode(value) ? value : DEFAULT_COLOR_MODE;
}
