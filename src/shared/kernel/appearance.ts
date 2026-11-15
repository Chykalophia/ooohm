/**
 * The company's look: one of a fixed set of themes, an optional accent colour of the
 * admin's choosing, a corner style and how Home asks for time off. Chosen by an admin for the whole company, never
 * per person. Every theme keeps the product rule of one accent colour.
 */
import { DomainError } from "./errors";

export interface ThemeInfo {
  label: string;
  /** One line for the picker. */
  description: string;
  /** The theme's own accent, shown as a swatch next to the colour field. */
  accent: string;
}

/** The themes an admin can pick, in the order the picker shows them. `classic` is the default. */
export const THEMES = {
  classic: { label: "Classic", description: "Calm deep teal. The original look, with dark mode.", accent: "#115e59" },
  cobalt: { label: "Cobalt", description: "Precise and modern: hairline borders and cobalt blue.", accent: "#2546d0" },
  marigold: { label: "Ink & Marigold", description: "Navy ink with a warm marigold accent.", accent: "#f2a900" },
  saffron: { label: "Saffron", description: "Friendly and tactile, with rounded controls.", accent: "#ff9f1c" },
  graphite: { label: "Graphite", description: "Quiet monochrome. Color only where it means something.", accent: "#18181b" },
  plum: { label: "Plum", description: "Soft and grown-up, with pill buttons.", accent: "#6b2d5c" },
  signal: { label: "Signal", description: "Bold Swiss type, square corners and pastel lines.", accent: "#e0301e" },
  forest: { label: "Forest", description: "Restful greens with serif headings.", accent: "#1f4d3a" },
  frost: { label: "Frost", description: "Playful frosted glass over a soft color wash.", accent: "#1f6feb" },
} as const satisfies Record<string, ThemeInfo>;

export type ThemeKey = keyof typeof THEMES;
export const THEME_KEYS = Object.keys(THEMES) as ThemeKey[];
export const DEFAULT_THEME: ThemeKey = "classic";

/** `theme` keeps the theme's own corners; the others override them everywhere. */
export const CORNER_STYLES = ["theme", "square", "soft", "round"] as const;
export type CornerStyle = (typeof CORNER_STYLES)[number];

export const CORNER_LABELS: Readonly<Record<CornerStyle, string>> = {
  theme: "As the theme draws them",
  square: "Square",
  soft: "Slightly rounded",
  round: "Rounded",
};

/**
 * How Home asks for time off: the labelled `form`, or one editable `sentence` ("I'm
 * taking Vacation from Mon 23 Nov to Wed 25 Nov, full days."). Both send the same request.
 */
export const REQUEST_STYLES = ["form", "sentence"] as const;
export type RequestStyle = (typeof REQUEST_STYLES)[number];

/**
 * Layout trials: the same screens arranged after different design methods, for an admin
 * to try on the whole company and compare. `standard` is the default. Each changes
 * spacing, shape and navigation only; the content, actions and theme colours stay.
 */
export const LAYOUTS = ["standard", "tonal", "grouped", "compact", "legible"] as const;
export type Layout = (typeof LAYOUTS)[number];

export const LAYOUT_LABELS: Readonly<Record<Layout, { label: string; description: string }>> = {
  standard: { label: "Standard", description: "Today's layout: bordered cards and a top bar." },
  tonal: { label: "Tonal", description: "Soft filled cards, big balance numbers and a large request button." },
  grouped: { label: "Grouped", description: "Large titles and inset lists, like a phone's settings app." },
  compact: { label: "Compact", description: "A side menu, tighter spacing and wider tables, for people who live in it." },
  legible: { label: "Legible", description: "Larger text, 48px targets, bold focus rings and underlined links." },
};

export const REQUEST_STYLE_LABELS: Readonly<Record<RequestStyle, { label: string; description: string }>> = {
  form: { label: "Form", description: "Labelled fields for type, dates and part of the day." },
  sentence: { label: "Sentence", description: "One short sentence with the choices inside it, like a note to your manager." },
};

export interface Appearance {
  theme: ThemeKey;
  /** `#rrggbb`, or null for the theme's own accent. */
  accentColor: string | null;
  corners: CornerStyle;
  requestStyle: RequestStyle;
  layout: Layout;
}

export const DEFAULT_APPEARANCE: Appearance = { theme: DEFAULT_THEME, accentColor: null, corners: "theme", requestStyle: "form", layout: "standard" };

export interface AppearanceInput {
  theme: string;
  /** Blank or absent keeps the theme's own accent. */
  accentColor?: string | null;
  corners: string;
  /** Absent keeps the default, `form`. */
  requestStyle?: string;
  /** Absent keeps the default, `standard`. */
  layout?: string;
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isThemeKey(value: string): value is ThemeKey {
  return Object.hasOwn(THEMES, value);
}

function isCornerStyle(value: string): value is CornerStyle {
  return (CORNER_STYLES as readonly string[]).includes(value);
}

function isLayout(value: string): value is Layout {
  return (LAYOUTS as readonly string[]).includes(value);
}

function isRequestStyle(value: string): value is RequestStyle {
  return (REQUEST_STYLES as readonly string[]).includes(value);
}

/**
 * Checks and normalizes what the appearance form sent.
 *
 * @throws DomainError `invalid_input`: an unknown theme, corner style, request style or layout,
 *   or an accent that is not a hex colour.
 */
export function normalizeAppearance(input: AppearanceInput): Appearance {
  const theme = input.theme.trim();
  if (!isThemeKey(theme)) throw new DomainError("invalid_input", "Unknown theme.");
  const corners = input.corners.trim();
  if (!isCornerStyle(corners)) throw new DomainError("invalid_input", "Unknown corner style.");
  const requestStyle = (input.requestStyle ?? "form").trim();
  if (!isRequestStyle(requestStyle)) throw new DomainError("invalid_input", "Unknown request style.");
  const layout = (input.layout ?? "standard").trim();
  if (!isLayout(layout)) throw new DomainError("invalid_input", "Unknown layout.");
  const raw = (input.accentColor ?? "").trim();
  if (raw === "") return { theme, accentColor: null, corners, requestStyle, layout };
  const accentColor = readAccent(raw);
  if (!accentColor) throw new DomainError("invalid_input", "Accent colours are hex values like #2546d0.");
  // The theme's own accent picked as "custom" is no custom accent: keep the theme's, so
  // Classic keeps following dark mode.
  if (accentColor === THEMES[theme].accent) return { theme, accentColor: null, corners, requestStyle, layout };
  return { theme, accentColor, corners, requestStyle, layout };
}

/**
 * The appearance as stored, made safe to render: a theme, corner style, request style or layout this version
 * does not know (written by a newer version, or by hand) falls back to the default
 * instead of failing the page.
 */
export function readAppearance(stored: {
  theme: string;
  accentColor: string | null;
  corners: string;
  requestStyle: string;
  layout: string;
}): Appearance {
  return {
    theme: isThemeKey(stored.theme) ? stored.theme : DEFAULT_THEME,
    accentColor: readAccent(stored.accentColor),
    corners: isCornerStyle(stored.corners) ? stored.corners : "theme",
    requestStyle: isRequestStyle(stored.requestStyle) ? stored.requestStyle : "form",
    layout: isLayout(stored.layout) ? stored.layout : "standard",
  };
}

function readAccent(stored: string | null): string | null {
  const m = HEX.exec((stored ?? "").trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return `#${hex.toLowerCase()}`;
}

/**
 * Whether the app may follow the device's dark mode. Only the classic theme with its own
 * accent has a dark palette so far; every other look is light only.
 */
export function followsDarkMode(appearance: Pick<Appearance, "theme" | "accentColor">): boolean {
  return appearance.theme === "classic" && appearance.accentColor === null;
}

/**
 * The company's one accent as stored: the admin's custom colour, or the theme's own.
 * An unknown theme falls back to the default, as in {@link readAppearance}.
 */
export function companyAccent(stored: { theme: string; accentColor: string | null }): string {
  return readAccent(stored.accentColor) ?? THEMES[isThemeKey(stored.theme) ? stored.theme : DEFAULT_THEME].accent;
}
