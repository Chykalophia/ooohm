/**
 * How a person wants the app drawn. A display preference of their own: it changes
 * nothing anyone else sees, so it is neither audited nor sent to integrations.
 *
 * - `light`: the default, for everyone until they choose otherwise.
 * - `dark`: always dark.
 * - `system`: follows the device's light or dark setting, and switches with it.
 */
export const THEMES = ["light", "dark", "system"] as const;

export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = "light";

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/** The stored preference, or the default for anything else (no session, an unknown value). */
export function themeOrDefault(value: unknown): Theme {
  return isTheme(value) ? value : DEFAULT_THEME;
}
