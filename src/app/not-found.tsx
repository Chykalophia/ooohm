import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/layout/logo";
import { Card } from "@/components/ui/card";
import { buttonClass, cx, focusRing } from "@/components/ui/styles";

export const metadata: Metadata = { title: "Page not found · OOOhm" };

/**
 * Every 404: an unknown address, a request or person this account can't see, an admin
 * page for someone who isn't one. Themed like the rest, with a heading, a main landmark
 * and a way back, instead of the framework's bare page.
 */
export default function NotFound() {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <Card as="div" padding="lg" className="w-full max-w-sm space-y-6 text-center">
        <Link href="/" aria-label="OOOhm home" className={cx("inline-block rounded-md", focusRing)}>
          <Logo className="text-2xl" />
        </Link>
        <div className="space-y-2">
          <h1 className="text-xl font-semibold">Page not found</h1>
          <p className="text-sm text-muted">It may have moved, or it isn&apos;t one you can open with this account.</p>
        </div>
        <Link href="/" className={buttonClass("primary")}>
          Go to your time off
        </Link>
      </Card>
    </main>
  );
}
