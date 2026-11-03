import type { Metadata } from "next";
import { connection } from "next/server";
// Self-hosted faces for the themes (Admin → Appearance). Each only declares @font-face,
// so a browser downloads just the face the chosen theme uses.
import "@fontsource-variable/archivo";
import "@fontsource-variable/geist";
import "@fontsource-variable/hanken-grotesk";
import "@fontsource-variable/lexend";
import "@fontsource-variable/newsreader";
import "@fontsource-variable/onest";
import "@fontsource-variable/plus-jakarta-sans";
import "@fontsource-variable/sora";
import "@fontsource-variable/source-sans-3";
import "./globals.css";
import { colorModeOrDefault } from "@/domain/color-mode";
import { htmlAppearance } from "@/lib/appearance";
import { currentUser } from "@/lib/auth";
import { requestAppearance } from "./_lib/appearance";

export const metadata: Metadata = {
  title: "OOOhm",
  description: "Out Of Office, Holiday Manager. Zero resistance time off.",
  // The SVG follows the company's theme; /favicon.ico (in public/) is the classic-teal
  // fallback for browsers without SVG icons. Listing icons here replaces the ones Next
  // would add from files, so the home-screen icon (apple-icon.tsx) is listed too.
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "32x32" },
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/apple-icon", sizes: "180x180", type: "image/png" }],
  },
};

/**
 * `<html>` carries the company's look (`data-ui`, `data-corners`, a custom accent's
 * tokens) and the signed-in person's colour mode (`data-mode`, light when signed out or
 * when the look has no dark version), so every page is drawn right from the first
 * paint (see globals.css). Both are read per request, never at build time; the session
 * read is shared with the page's own (`currentUser` is read once per render).
 *
 * `suppressHydrationWarning` on `<html>` and `<body>` only: browser extensions (grammar
 * checkers such as LanguageTool and Grammarly, password managers, dark-mode tools) add
 * attributes to these two elements before React hydrates, which React reports as a
 * mismatch it cannot fix. The flag covers those elements' own attributes, one level
 * deep, so a real mismatch anywhere in the app is still reported.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await connection();
  const [appearance, user] = await Promise.all([requestAppearance(), currentUser()]);
  const { attributes, style } = htmlAppearance(appearance, colorModeOrDefault(user?.colorMode));

  return (
    <html lang="en" className="h-full antialiased" {...attributes} style={style as React.CSSProperties} suppressHydrationWarning>
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
