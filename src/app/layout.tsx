import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OOOhm",
  description: "Out Of Office, Holiday Manager. Zero resistance time off.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
