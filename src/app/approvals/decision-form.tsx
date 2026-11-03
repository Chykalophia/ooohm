"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { NOTE_MAX_LENGTH } from "@/domain/leave-request";
import { type FormState, IDLE } from "@/app/form-state";
import { decideLeaveAction } from "./actions";
import { DECLINE_EVENT } from "./approval-keys";

/**
 * Approve or decline one request. The optional reason is sent with either button and
 * the requester sees it, in their email and on their dashboard.
 */
export function DecisionForm({ requestId }: { requestId: string }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(decideLeaveAction, IDLE);
  const outcome = useRef<HTMLParagraphElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const reason = useRef<HTMLInputElement>(null);
  const declineButton = useRef<HTMLButtonElement>(null);
  // Set by the D shortcut: Enter in the reason field then declines instead of approving.
  const [declining, setDeclining] = useState(false);

  useEffect(() => {
    const el = form.current;
    if (!el) return;
    const start = () => {
      setDeclining(true);
      reason.current?.focus();
    };
    el.addEventListener(DECLINE_EVENT, start);
    return () => el.removeEventListener(DECLINE_EVENT, start);
  }, [state]);

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
    <form ref={form} action={formAction} className="space-y-3">
      <input type="hidden" name="requestId" value={requestId} />
      <label className="block space-y-1.5">
        <span className="text-sm text-muted">Reason (optional)</span>
        <input
          ref={reason}
          type="text"
          name="reason"
          placeholder={declining ? "Why, then Enter to decline" : undefined}
          onKeyDown={(e) => {
            if (declining && e.key === "Enter") {
              e.preventDefault();
              declineButton.current?.click();
            } else if (declining && e.key === "Escape") {
              setDeclining(false);
            }
          }}
          maxLength={NOTE_MAX_LENGTH}
          className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" name="decision" value="approve" disabled={pending} className={`${button} bg-accent text-accent-foreground`}>
          Approve
        </button>
        <button
          ref={declineButton}
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
