/**
 * The company's logo: a PNG or JPEG an admin uploads, shown in place of the OOOhm
 * wordmark in the app's header, on the sign-in page and at the top of emails. Only
 * these two formats: every mail client draws them, and neither can carry script (SVG
 * can, and Outlook draws neither SVG nor WebP).
 */
import { DomainError } from "./errors";

/** Large enough for any sharp logo; small enough to send in every email without thought. */
export const LOGO_MAX_BYTES = 512 * 1024;
/** Longest side in pixels. A logo shows at most a few hundred pixels wide. */
export const LOGO_MAX_SIDE = 4096;

export const LOGO_TYPES = ["image/png", "image/jpeg"] as const;
export type LogoType = (typeof LOGO_TYPES)[number];

const EXTENSIONS: Readonly<Record<LogoType, string>> = { "image/png": "png", "image/jpeg": "jpg" };

export const LOGO_RULES = "Logos are PNG or JPEG files up to 512 KB, at most 4096 pixels on a side.";

/** What a file's own bytes say it is. */
export interface LogoImage {
  contentType: LogoType;
  width: number;
  height: number;
}

/** A stored logo: its image and the SHA-256 (hex) of its bytes, which names it in URLs. */
export interface StoredLogo extends LogoImage {
  sha256: string;
}

/** A logo ready to draw: where it is, what it says, and the size to draw it at. */
export interface LogoRef {
  src: string;
  alt: string;
  width: number;
  height: number;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isLogoSha(value: string): boolean {
  return SHA256_HEX.test(value);
}

function isLogoType(value: string): value is LogoType {
  return (LOGO_TYPES as readonly string[]).includes(value);
}

function u16(b: Uint8Array, at: number): number {
  return (b[at] << 8) | b[at + 1];
}

function u32(b: Uint8Array, at: number): number {
  return ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width and height from a PNG's IHDR chunk, which the format requires first. */
function pngSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 24 || !PNG_SIGNATURE.every((v, i) => b[i] === v)) return null;
  if (String.fromCharCode(b[12], b[13], b[14], b[15]) !== "IHDR") return null;
  return { width: u32(b, 16), height: u32(b, 20) };
}

/**
 * Width and height from a JPEG's frame header (any SOF marker), walking the segments
 * before it. Markers C4 (Huffman tables), C8 (reserved) and CC (arithmetic coding) share
 * the SOF range but are not frames.
 */
function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1];
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    const length = u16(b, at + 2);
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 > b.length) return null;
      return { width: u16(b, at + 7), height: u16(b, at + 5) };
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    at += 2 + length;
  }
  return null;
}

/**
 * Reads what an uploaded file is from its bytes, never from its name or the type the
 * browser claimed.
 *
 * @throws DomainError `invalid_input`: not a PNG or JPEG, too large, or an impossible size.
 */
export function readLogoImage(bytes: Uint8Array): LogoImage {
  if (bytes.length === 0 || bytes.length > LOGO_MAX_BYTES) throw new DomainError("invalid_input", LOGO_RULES);
  const png = pngSize(bytes);
  const jpeg = png ? null : jpegSize(bytes);
  const size = png ?? jpeg;
  if (!size || [size.width, size.height].some((s) => s < 1 || s > LOGO_MAX_SIDE)) throw new DomainError("invalid_input", LOGO_RULES);
  return { contentType: png ? "image/png" : "image/jpeg", ...size };
}

/**
 * The stored logo columns, made safe to use: anything incomplete, or a type this
 * version does not serve, reads as no logo.
 */
export function readStoredLogo(stored: {
  logoSha256: string | null;
  logoType: string | null;
  logoWidth: number | null;
  logoHeight: number | null;
}): StoredLogo | null {
  const { logoSha256: sha256, logoType: contentType, logoWidth: width, logoHeight: height } = stored;
  if (!sha256 || !isLogoSha(sha256) || !contentType || !isLogoType(contentType)) return null;
  if (!width || !height || width < 1 || height < 1) return null;
  return { sha256, contentType, width, height };
}

/** The logo's path in the app, named by its content, so it can be cached forever. */
export function companyLogoPath(logo: Pick<StoredLogo, "sha256" | "contentType">): string {
  return `/logo/${logo.sha256}.${EXTENSIONS[logo.contentType]}`;
}

/** Splits `<sha256>.<ext>` from a logo URL; null for anything else. */
export function parseLogoFile(file: string): { sha256: string; contentType: LogoType } | null {
  const dot = file.lastIndexOf(".");
  if (dot < 0) return null;
  const sha256 = file.slice(0, dot);
  const contentType = LOGO_TYPES.find((t) => EXTENSIONS[t] === file.slice(dot + 1));
  return contentType && isLogoSha(sha256) ? { sha256, contentType } : null;
}

/** The size to draw a logo at inside a box: its own shape, never enlarged, never 0. */
export function fitLogo(
  logo: { width: number; height: number },
  box: { maxWidth: number; maxHeight: number },
): { width: number; height: number } {
  const scale = Math.min(1, box.maxWidth / logo.width, box.maxHeight / logo.height);
  return { width: Math.max(1, Math.round(logo.width * scale)), height: Math.max(1, Math.round(logo.height * scale)) };
}

/** The header's and sign-in page's logo box, in CSS pixels. */
export const APP_LOGO_BOX = { maxWidth: 120, maxHeight: 32 };
/** The email logo box, in CSS pixels. */
export const EMAIL_LOGO_BOX = { maxWidth: 200, maxHeight: 40 };

/** A stored logo as the app draws it: at its path, named by the company. */
export function appLogoRef(logo: StoredLogo, companyName: string): LogoRef {
  return { src: companyLogoPath(logo), alt: companyName, ...fitLogo(logo, APP_LOGO_BOX) };
}
