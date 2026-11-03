"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ErrorMessage } from "@/components/forms/form-status";
import { cx, focusRing } from "@/components/ui/styles";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
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
    <span className="flex items-center gap-2">
      {failed && <ErrorMessage>Couldn&apos;t sign out. Try again.</ErrorMessage>}
      <button type="button" className={cx("rounded-md text-muted hover:text-foreground", focusRing)} onClick={signOut}>
        Sign out
      </button>
    </span>
  );
}
