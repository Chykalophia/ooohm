import { companyAccent, DEFAULT_THEME, THEMES } from "@/domain/appearance";
import { EMAIL_LOGO_BOX, type LogoRef, companyLogoPath, fitLogo, readStoredLogo } from "@/domain/company-logo";
import { type AccentTokens, accentTokens } from "@/lib/appearance";

/**
 * The shared look of every OOOhm email: a white card on the app's warm grey, with the
 * company's accent on the main button, links and small marks only. Inline styles and
 * tables, since mail clients drop stylesheets.
 */

/**
 * The company's look in an email: the accent colours, worked out like the app's so text
 * stays readable, and its logo (at an absolute URL) when it has one.
 */
export type EmailAccent = AccentTokens & { logo?: LogoRef };

/** Classic's teal and the OOOhm wordmark: the look when the company's is unknown. */
export const DEFAULT_EMAIL_ACCENT: EmailAccent = accentTokens(THEMES[DEFAULT_THEME].accent);

/** What {@link emailAccent} reads of a company. The name and logo columns are optional. */
export interface EmailCompany {
  theme: string;
  accentColor: string | null;
  name?: string;
  logoSha256?: string | null;
  logoType?: string | null;
  logoWidth?: number | null;
  logoHeight?: number | null;
}

/**
 * The look for a company's stored appearance, or the default when there is none. The
 * logo needs `appUrl`, the app's public URL, since an email can only point at an
 * absolute one.
 */
export function emailAccent(stored: EmailCompany | null | undefined, appUrl?: string): EmailAccent {
  if (!stored) return DEFAULT_EMAIL_ACCENT;
  const tokens = accentTokens(companyAccent(stored));
  const logo = readStoredLogo({
    logoSha256: stored.logoSha256 ?? null,
    logoType: stored.logoType ?? null,
    logoWidth: stored.logoWidth ?? null,
    logoHeight: stored.logoHeight ?? null,
  });
  if (!logo || !appUrl || !stored.name) return tokens;
  const src = `${appUrl.replace(/\/+$/, "")}${companyLogoPath(logo)}`;
  return { ...tokens, logo: { src, alt: stored.name, ...fitLogo(logo, EMAIL_LOGO_BOX) } };
}

/** Escapes `& < > " '` for HTML text and attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** The app's neutral palette (light). */
export const INK = "#1c1917";
export const BODY = "#44403c";
export const MUTED = "#78716c";
const BORDER = "#e7e5e4";
const BORDER_STRONG = "#d6d3d1";
const GROUND = "#fafaf9";
const FONT = "'Instrument Sans',system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * The message's main line, as its one heading, styled like a paragraph: screen reader
 * users can jump to it, and it reads no louder than before.
 */
export function heading(html: string): string {
  return `<h1 style="margin:0 0 12px;font-size:16px;line-height:1.5;font-weight:400">${html}</h1>`;
}

/** One paragraph of already-escaped HTML. */
export function paragraph(html: string, style = ""): string {
  return `<p style="margin:0 0 12px;${style}">${html}</p>`;
}

/** A small round mark in the accent, before a line such as who else is off. */
export function dot(accent: EmailAccent): string {
  return (
    `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${accent.accent};` +
    `margin-right:8px;vertical-align:middle;position:relative;top:-1px"></span>`
  );
}

export interface EmailButton {
  label: string;
  href: string;
  /** `primary` is filled with the accent; `quiet` is outlined. */
  variant: "primary" | "quiet";
}

/**
 * One button as a table cell carrying the fill (`bgcolor`), so Outlook desktop, which
 * ignores padding and backgrounds on links, still draws a button; other clients use the
 * link's own padding and corners.
 */
function button(b: EmailButton, accent: EmailAccent): string {
  const [fill, text, edge] =
    b.variant === "primary" ? [accent.accent, accent.accentForeground, accent.accent] : ["#ffffff", INK, BORDER_STRONG];
  return (
    `<td bgcolor="${fill}" style="background:${fill};border:1px solid ${edge};border-radius:8px">` +
    `<a href="${escapeHtml(b.href)}" style="display:inline-block;background:${fill};color:${text};font-family:${FONT};font-size:15px;` +
    `font-weight:500;line-height:20px;text-decoration:none;padding:9px 16px;border-radius:8px">` +
    `${escapeHtml(b.label)}</a></td>`
  );
}

/** A row of buttons, the main one first. */
export function buttons(list: readonly EmailButton[], accent: EmailAccent): string {
  if (list.length === 0) return "";
  const cells = list.map((b) => button(b, accent)).join(`<td style="width:8px;font-size:0;line-height:0">&nbsp;</td>`);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 0"><tr>${cells}</tr></table>`;
}

/** A plain link in the accent's text colour. */
export function link(href: string, label: string, accent: EmailAccent): string {
  return `<a href="${escapeHtml(href)}" style="color:${accent.accentInk};text-decoration:underline">${escapeHtml(label)}</a>`;
}

/**
 * The top line: the company's logo, sized with attributes as well as styles so Outlook
 * keeps its shape, or the OOOhm wordmark. With images blocked, the logo's alt text names
 * the company.
 */
function masthead(accent: EmailAccent): string {
  const cell = `<tr><td style="padding:0 4px 14px;font-family:${FONT};font-size:17px;font-weight:600;letter-spacing:-0.01em;color:${accent.accentInk}">`;
  if (!accent.logo) return `${cell}OOOhm</td></tr>`;
  const { src, alt, width, height } = accent.logo;
  return (
    `${cell}<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" width="${width}" height="${height}" ` +
    `style="display:block;border:0;outline:none;width:${width}px;height:${height}px"></td></tr>`
  );
}

/**
 * The whole HTML document: the company's logo or the OOOhm wordmark, then `body` in a card, then an optional
 * quiet `footer` line under it. Both are HTML and go in as given: build them from
 * {@link escapeHtml}, {@link paragraph}, {@link link} and {@link buttons}, never from raw
 * text. `title` (plain text, the subject) names the document for screen readers and
 * browser-based mail clients.
 */
export function emailDocument(bodyHtml: string, accent: EmailAccent, footerHtml: string | undefined, title: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
    `<meta name="color-scheme" content="light"><title>${escapeHtml(title)}</title></head>` +
    `<body style="margin:0;padding:0;background:${GROUND}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${GROUND}">` +
    `<tr><td align="center" style="padding:32px 16px">` +
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px">` +
    masthead(accent) +
    `<tr><td style="background:#ffffff;border:1px solid ${BORDER};border-radius:14px;padding:24px;` +
    `font-family:${FONT};font-size:16px;line-height:1.5;color:${INK}">${bodyHtml}</td></tr>` +
    (footerHtml
      ? `<tr><td style="padding:14px 4px 0;font-family:${FONT};font-size:13px;line-height:1.5;color:${MUTED}">${footerHtml}</td></tr>`
      : "") +
    `</table></td></tr></table></body></html>`
  );
}
