"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ErrorMessage } from "@/components/forms/form-status";
import { authClient } from "@/lib/auth-client";

/**
 * Signs out and leaves for the sign-in page. Styled by its caller (a row of the
 * account menu); a failure shows below it.
 */
export function SignOutButton({ className }: { className: string }) {
  const router = useRouter();
  const [failed, setFailed] = useState(false);

  async function signOut() {
    setFailed(false);
    try {
      const { error } = await authClient.signOut();
      if (error) return setFailed(true);
    } catch {
      return setFailed(true);
    }
    // replace, not push: Back must not return to the signed-in page.
    router.replace("/sign-in");
  }

  return (
    <>
      <button type="button" className={className} onClick={signOut}>
        Sign out
      </button>
      {failed && (
        <ErrorMessage as="p" className="px-3 pb-2 text-sm">
          Couldn&apos;t sign out. Try again.
        </ErrorMessage>
      )}
    </>
  );
}
