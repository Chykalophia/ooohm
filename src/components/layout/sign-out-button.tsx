"use client";

import { useState } from "react";
import { ErrorMessage } from "@/components/forms/form-status";
import { authClient } from "@/lib/auth-client";

/**
 * Signs out and leaves for the sign-in page. Styled by its caller (a row of the
 * account menu); a failure shows below it.
 */
export function SignOutButton({ className }: { className: string }) {
  const [failed, setFailed] = useState(false);

  async function signOut() {
    setFailed(false);
    try {
      const { error } = await authClient.signOut();
      if (error) return setFailed(true);
    } catch {
      return setFailed(true);
    }
    // A full load, not a client navigation: the root layout (which draws the theme) only
    // renders again on one, so the sign-in page gets the signed-out default, and the
    // router's cached signed-in pages are dropped. replace, not assign: Back must not
    // return to the signed-in page.
    window.location.replace("/sign-in");
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
