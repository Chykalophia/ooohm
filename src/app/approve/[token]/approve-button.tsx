"use client";

import { useActionState } from "react";
import { type ApproveOutcome, approveFromEmailAction } from "./actions";

/** One button that approves; its outcome takes its place. */
export function ApproveButton({ token }: { token: string }) {
  const [outcome, formAction, pending] = useActionState<ApproveOutcome, FormData>(approveFromEmailAction, { status: "idle" });
  if (outcome.status === "done") {
    return (
      <p role="status" className={`font-medium ${outcome.state === "approved" ? "text-accent-ink" : "text-foreground"}`}>
        {outcome.message}
      </p>
    );
  }
  return (
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
  );
}
