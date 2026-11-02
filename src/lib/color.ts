/**
 * Colour helpers for leave type colours, which admins choose freely. Pure; safe on the
 * client.
 */
import { DEFAULT_LEAVE_TYPE_COLOR } from "@/domain/leave-type-settings";

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** The colour as `#rrggbb`, or {@link DEFAULT_LEAVE_TYPE_COLOR} when it is not a hex colour. */
export function normalizeHexColor(color: string): string {
  const m = HEX.exec(color.trim());
  if (!m) return DEFAULT_LEAVE_TYPE_COLOR;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return `#${hex.toLowerCase()}`;
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a hex colour (0 = black, 1 = white). */
export function relativeLuminance(color: string): number {
  const hex = normalizeHexColor(color).slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Black or white, whichever reads better on `background`, so a label on a solid chip
 * in any leave type colour stays legible.
 */
export function readableTextColor(background: string): "#000000" | "#ffffff" {
  return contrastRatio(background, "#ffffff") >= contrastRatio(background, "#000000") ? "#ffffff" : "#000000";
}
