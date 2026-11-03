"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef } from "react";
import { buttonClass, cx, textLink } from "@/components/ui/styles";
import { type ApproveOutcome, approveFromEmailAction } from "./actions";

const linkClass = cx(textLink, "text-sm text-accent-ink");

/** One button that approves, and the way into the app to decline; the outcome takes the button's place. */
export function ApproveButton({ token }: { token: string }) {
  const [outcome, formAction, pending] = useActionState<ApproveOutcome, FormData>(approveFromEmailAction, { status: "idle" });
  // The button that had focus is gone once there is an outcome; the outcome takes its focus.
  const status = useRef<HTMLParagraphElement>(null);
  const done = outcome.status === "done";
  useEffect(() => {
    if (done) status.current?.focus();
  }, [done]);
  if (outcome.status === "done") {
    return (
      <>
        <p
          ref={status}
          tabIndex={-1}
          role="status"
          className={cx("font-medium outline-none", outcome.state === "approved" ? "text-accent-ink" : "text-foreground")}
        >
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
        <button type="submit" disabled={pending} className={cx(buttonClass("primary"), "w-full")}>
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
