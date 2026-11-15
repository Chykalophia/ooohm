/**
 * Colour helpers for leave type colours, which admins choose freely. Pure; safe on the
 * client.
 */
import { DEFAULT_LEAVE_TYPE_COLOR } from "@/shared/kernel/leave-type-settings";

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** The colour as `#rrggbb`, or {@link DEFAULT_LEAVE_TYPE_COLOR} when it is not a hex colour. */
export function normalizeHexColor(color: string): string {
  const m = HEX.exec(color.trim());
  if (!m) return DEFAULT_LEAVE_TYPE_COLOR;
  // Group 1 is not optional, so it is there whenever the pattern matched.
  const digits = m[1] ?? "";
  const hex = digits.length === 3 ? [...digits].map((c) => c + c).join("") : digits;
  return `#${hex.toLowerCase()}`;
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a hex colour (0 = black, 1 = white). */
export function relativeLuminance(color: string): number {
  const hex = normalizeHexColor(color).slice(1);
  const [r = 0, g = 0, b = 0] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Black or white, whichever reads better on `background`, so a label on a solid chip
 * in any leave type colour stays legible.
 */
export function readableTextColor(background: string): "#000000" | "#ffffff" {
  return contrastRatio(background, "#ffffff") >= contrastRatio(background, "#000000") ? "#ffffff" : "#000000";
}
