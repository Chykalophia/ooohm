"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { focusRing } from "@/app/styles";

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
      {failed && (
        <span role="alert" className="text-red-700 dark:text-red-400">
          Couldn&apos;t sign out. Try again.
        </span>
      )}
      <button type="button" className={`inline-flex min-h-6 items-center rounded-md text-muted hover:text-foreground ${focusRing}`} onClick={signOut}>
        Sign out
      </button>
    </span>
  );
}
