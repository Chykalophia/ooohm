"use client";

import Link from "next/link";
import { useActionState } from "react";
import { type ApproveOutcome, approveFromEmailAction } from "./actions";

const linkClass =
  "rounded-md text-sm text-accent-ink underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink";

/** One button that approves, and the way into the app to decline; the outcome takes the button's place. */
export function ApproveButton({ token }: { token: string }) {
  const [outcome, formAction, pending] = useActionState<ApproveOutcome, FormData>(approveFromEmailAction, { status: "idle" });
  if (outcome.status === "done") {
    return (
      <>
        <p role="status" className={`font-medium ${outcome.state === "approved" ? "text-accent-ink" : "text-foreground"}`}>
          {outcome.message}
        </p>
        <p>
          <Link href="/approvals" className={linkClass}>
            Open OOOhm
          </Link>
        </p>
      </>
    );
  }
  return (
    <>
      <form action={formAction}>
        <input type="hidden" name="token" value={token} />
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-lg bg-accent px-4 py-2.5 font-medium text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink disabled:opacity-60"
        >
          {pending ? "Approving…" : "Approve"}
        </button>
      </form>
      <p>
        <Link href="/approvals" className={linkClass}>
          Decline or look closer in OOOhm
        </Link>
      </p>
    </>
  );
}
