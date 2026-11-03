"use client";

import { useActionState, useEffect, useRef } from "react";
import { NOTE_MAX_LENGTH } from "@/domain/leave-request";
import { type FormState, IDLE } from "@/app/form-state";
import { decideLeaveAction } from "./actions";

/**
 * Approve or decline one request. The optional reason is sent with either button and
 * the requester sees it, in their email and on their dashboard.
 */
export function DecisionForm({ requestId }: { requestId: string }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(decideLeaveAction, IDLE);
  const outcome = useRef<HTMLParagraphElement>(null);

  // The outcome replaces the form, including the button that had focus.
  useEffect(() => {
    if (state.status === "success") outcome.current?.focus();
  }, [state]);

  if (state.status === "success") {
    return (
      <p ref={outcome} tabIndex={-1} role="status" className="text-sm font-medium text-accent-ink outline-none">
        {state.message}
      </p>
    );
  }

  const button = "rounded-lg px-3 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink disabled:opacity-60";

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="requestId" value={requestId} />
      <label className="block space-y-1.5">
        <span className="text-sm text-muted">Reason (optional)</span>
        <input
          type="text"
          name="reason"
          maxLength={NOTE_MAX_LENGTH}
          className="w-full rounded-lg border border-field bg-surface px-3 py-1.5 text-sm outline-none focus-within:border-accent-ink focus-within:ring-2 focus-within:ring-accent-ink/20"
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" name="decision" value="approve" disabled={pending} className={`${button} bg-accent text-accent-foreground`}>
          Approve
        </button>
        <button
          type="submit"
          name="decision"
          value="reject"
          disabled={pending}
          className={`${button} border border-border text-foreground hover:bg-background`}
        >
          Decline
        </button>
        {state.status === "error" && (
          <span role="alert" className="text-sm text-red-700 dark:text-red-400">
            {state.message}
          </span>
        )}
      </div>
    </form>
  );
}
