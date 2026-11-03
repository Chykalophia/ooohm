/**
 * The OOOhm mark: an Ω (the "ohm" in the name) on a rounded tile, coloured with the
 * company's accent. Pure; the favicon route, the home-screen icon and the header mark
 * all draw from here so they never drift apart.
 */
import { type Appearance, THEMES, followsDarkMode } from "@/domain/appearance";
import { accentTokens } from "./appearance";
import { contrastRatio, normalizeHexColor } from "./color";

/** The Ω on a 32 × 32 grid, drawn as one stroke so it stays crisp at 16px. */
export const OHM_PATH = "M7.5 24.5H12.6V21.2A7.5 7.5 0 1 1 19.4 21.2V24.5H24.5";
export const OHM_STROKE_WIDTH = 3.1;
/** The Ω's share of the tile; the rest is breathing room. */
export const OHM_SCALE = 0.78;

/**
 * A dark browser tab bar (Chrome's dark tab strip). A tile that is too dark to see
 * against it is lightened for dark mode.
 */
export const DARK_TAB = "#202124";
/** WCAG 1.4.11: graphical objects need 3:1 against what is next to them. */
const DARK_TAB_CONTRAST = 3;

export interface MarkColors {
  tile: string;
  mark: string;
}

function mixWithWhite(hex: string, amount: number): string {
  const n = normalizeHexColor(hex).slice(1);
  const parts = [0, 2, 4].map((i) => {
    const c = parseInt(n.slice(i, i + 2), 16);
    return Math.round(c + (255 - c) * amount);
  });
  return `#${parts.map((p) => p.toString(16).padStart(2, "0")).join("")}`;
}

/** The accent an appearance paints with: the admin's own colour, or the theme's. */
export function appearanceAccent(appearance: Appearance): string {
  return normalizeHexColor(appearance.accentColor ?? THEMES[appearance.theme].accent);
}

/**
 * Classic's dark-mode `--accent` and `--accent-foreground` (under `[data-scheme="auto"]`
 * in globals.css; a unit test keeps the two in step), so the favicon matches the header
 * mark when the app itself is dark.
 */
export const CLASSIC_DARK_MARK: MarkColors = { tile: "#2dd4bf", mark: "#042f2e" };

/** The mark colours the app switches to in dark mode, or null when it keeps one accent. */
export function appearanceDarkMark(appearance: Appearance): MarkColors | null {
  return followsDarkMode(appearance) ? CLASSIC_DARK_MARK : null;
}

/** Tile and Ω colours for a light tab bar or page. */
export function markColors(accent: string): MarkColors {
  const t = accentTokens(accent);
  return { tile: t.accent, mark: t.accentForeground };
}

/** Tile and Ω colours for a dark tab bar: the accent, lightened until it reaches 3:1 against it. */
export function darkMarkColors(accent: string): MarkColors {
  let tile = normalizeHexColor(accent);
  for (let step = 1; step <= 10 && contrastRatio(tile, DARK_TAB) < DARK_TAB_CONTRAST; step++) {
    tile = mixWithWhite(accent, step / 10);
  }
  return markColors(tile);
}

const HEX_INPUT = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Every colour written into the SVG's `<style>` passes through here, so nothing but a
 * `#rrggbb` value can ever reach the markup, whatever a caller hands in. Anything else
 * becomes the default accent.
 */
function cssColor(color: string): string {
  return HEX_INPUT.test(color.trim()) ? normalizeHexColor(color) : THEMES.classic.accent;
}

/** Where the Ω sits on the 32 grid so it is centred at {@link OHM_SCALE}. */
export const OHM_OFFSET = Math.round(((32 - 32 * OHM_SCALE) / 2) * 100) / 100;

/**
 * The favicon as SVG. It carries its own dark-mode colours, so browsers that follow the
 * system scheme in favicons keep it visible on a dark tab bar.
 */
export function faviconSvg(accent: string, darkMark: MarkColors | null = null): string {
  const safe = ({ tile, mark }: MarkColors): MarkColors => ({ tile: cssColor(tile), mark: cssColor(mark) });
  const base = cssColor(accent);
  const light = safe(markColors(base));
  const dark = safe(darkMark ?? darkMarkColors(base));
  const style =
    `.t{fill:${light.tile}}.m{stroke:${light.mark}}` +
    (dark.tile === light.tile && dark.mark === light.mark ? "" : `@media (prefers-color-scheme:dark){.t{fill:${dark.tile}}.m{stroke:${dark.mark}}}`);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<style>${style}</style>` +
    `<rect class="t" width="32" height="32" rx="7"/>` +
    `<g transform="translate(${OHM_OFFSET} ${OHM_OFFSET}) scale(${OHM_SCALE})">` +
    `<path class="m" d="${OHM_PATH}" fill="none" stroke-width="${OHM_STROKE_WIDTH}" stroke-linejoin="round"/></g>` +
    `</svg>`
  );
}
