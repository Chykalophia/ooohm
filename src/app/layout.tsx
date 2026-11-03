import type { Metadata } from "next";
import { themeOrDefault } from "@/domain/theme";
import { currentUser } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: "OOOhm",
  description: "Out Of Office, Holiday Manager. Zero resistance time off.",
};

/**
 * `suppressHydrationWarning` on `<html>` and `<body>` only: browser extensions (grammar
 * checkers such as LanguageTool and Grammarly, password managers, dark-mode tools) add
 * attributes to these two elements before React hydrates, which React reports as a
 * mismatch it cannot fix. The flag covers those elements' own attributes, one level
 * deep, so a real mismatch anywhere in the app is still reported.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme={await signedInTheme()} className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}

/** Shares the page's own session lookup (`currentUser` is read once per render). */
async function signedInTheme() {
  return themeOrDefault((await currentUser())?.theme);
}
