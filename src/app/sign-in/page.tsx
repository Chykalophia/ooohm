import { connection } from "next/server";
import { Logo } from "@/components/layout/logo";
import { Card } from "@/components/ui/card";
import Link from "next/link";
import { env, googleEnabled } from "@/lib/env";
import { serviceContext } from "@/server/runtime";
import { installStatus } from "@/server/services/install";
import { textLink } from "@/components/ui/styles";
import { SignInForm } from "./sign-in-form";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string; setup?: string; email?: string }> }) {
  // Read runtime config (Google on/off) per request, not at build time.
  await connection();
  // Better Auth sends failed or expired links back here with ?error=...; setup sends the new admin here.
  const { error, setup, email } = await searchParams;
  const status = await installStatus(serviceContext(), env.SETUP_TOKEN);

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <Card as="div" padding="lg" className="w-full max-w-sm space-y-8">
        <div className="space-y-1 text-center">
          <h1 aria-label="Sign in to OOOhm">
            <Logo className="text-3xl" />
          </h1>
          <p className="text-sm text-muted">Zero resistance time off.</p>
        </div>
        {status === "installed" ? (
          <>
            {setup === "done" && (
              <p role="status" className="text-sm">
                OOOhm is set up. Send yourself a sign-in link to finish.
              </p>
            )}
            <SignInForm googleEnabled={googleEnabled} linkFailed={Boolean(error)} initialEmail={email?.slice(0, 320) ?? ""} />
          </>
        ) : status === "open" ? (
          <p className="text-sm">
            OOOhm isn&apos;t set up yet.{" "}
            <Link href="/setup" className={textLink}>
              Set it up
            </Link>{" "}
            with your setup token.
          </p>
        ) : (
          <p className="text-sm text-muted">
            OOOhm isn&apos;t set up yet. Set <code>SETUP_TOKEN</code> and open /setup, or run <code>pnpm db:seed</code>.
          </p>
        )}
      </Card>
    </main>
  );
}
