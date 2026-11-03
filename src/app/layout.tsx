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
import { htmlAppearance } from "@/lib/appearance";
import { serviceContext } from "@/server/runtime";
import { getAppearance } from "@/server/services/appearance";

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

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The company's theme is read per request, never at build time.
  await connection();
  const { attributes, style } = htmlAppearance(await getAppearance(serviceContext()));

  return (
    <html lang="en" className="h-full antialiased" {...attributes} style={style as React.CSSProperties}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
