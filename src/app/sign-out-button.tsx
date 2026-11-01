"use client";

import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      className="text-muted hover:text-foreground"
      onClick={async () => {
        await authClient.signOut();
        router.push("/sign-in");
      }}
    >
      Sign out
    </button>
  );
}
