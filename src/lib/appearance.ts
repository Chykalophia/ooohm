/**
 * Turns the company's appearance into what the root `<html>` element carries: the theme
 * and corner attributes the stylesheet keys on, and, for a custom accent, the colour
 * tokens worked out so that text and buttons stay readable. Pure; safe on the client.
 */
import { type Appearance, followsDarkMode } from "@/domain/appearance";
import { contrastRatio, normalizeHexColor } from "./color";

/** WCAG AA for normal text. */
const TEXT_CONTRAST = 4.5;

function mixWithBlack(hex: string, amount: number): string {
  const n = normalizeHexColor(hex).slice(1);
  const parts = [0, 2, 4].map((i) => Math.round(parseInt(n.slice(i, i + 2), 16) * (1 - amount)));
  return `#${parts.map((p) => p.toString(16).padStart(2, "0")).join("")}`;
}

export interface AccentTokens {
  /** Fills: the main button, today's date, selected states. */
  accent: string;
  /** Text on an accent fill: white or near-black, whichever reads better. */
  accentForeground: string;
  /** The accent as text and focus rings on light surfaces: darkened until it reaches 4.5:1 on white. */
  accentInk: string;
}

/** Colour tokens for a custom accent. A pale accent such as yellow keeps its fill and gets a darker ink for text. */
export function accentTokens(color: string): AccentTokens {
  const accent = normalizeHexColor(color);
  const accentForeground = contrastRatio(accent, "#ffffff") >= contrastRatio(accent, "#111111") ? "#ffffff" : "#111111";
  let accentInk = accent;
  for (let step = 1; step <= 10 && contrastRatio(accentInk, "#ffffff") < TEXT_CONTRAST; step++) {
    accentInk = mixWithBlack(accent, step / 10);
  }
  return { accent, accentForeground, accentInk };
}

export interface HtmlAppearance {
  /** `data-*` attributes for `<html>`. */
  attributes: Record<string, string>;
  /** CSS custom properties for `<html>`'s style, set only for a custom accent. */
  style: Record<string, string>;
}

export function htmlAppearance(appearance: Appearance): HtmlAppearance {
  const attributes: Record<string, string> = { "data-ui": appearance.theme };
  if (appearance.corners !== "theme") attributes["data-corners"] = appearance.corners;
  if (followsDarkMode(appearance)) attributes["data-scheme"] = "auto";
  const style: Record<string, string> = {};
  if (appearance.accentColor) {
    const t = accentTokens(appearance.accentColor);
    Object.assign(style, { "--accent": t.accent, "--accent-foreground": t.accentForeground, "--accent-ink": t.accentInk });
  }
  return { attributes, style };
}
