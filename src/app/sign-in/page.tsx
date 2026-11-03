import { connection } from "next/server";
import { Logo } from "@/components/logo";
import { googleEnabled } from "@/lib/env";
import { SignInForm } from "./sign-in-form";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  // Read runtime config (Google on/off) per request, not at build time.
  await connection();
  // Better Auth sends failed or expired links back here with ?error=...
  const { error } = await searchParams;

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-8 rounded-2xl border border-border bg-surface p-8">
        <div className="space-y-1 text-center">
          <Logo className="text-3xl" />
          <p className="text-sm text-muted">Zero resistance time off.</p>
        </div>
        <SignInForm googleEnabled={googleEnabled} linkFailed={Boolean(error)} />
      </div>
    </main>
  );
}
