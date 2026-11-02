"use client";

import { useEffect, useRef } from "react";
import { NOTE_MAX_LENGTH } from "@/domain/leave-request";
import { IDLE } from "@/components/forms/form-state";
import { ErrorMessage } from "@/components/forms/form-status";
import { useFormAction } from "@/components/forms/use-form-action";
import { TextField } from "@/components/ui/fields";
import { buttonClass } from "@/components/ui/styles";
import { decideLeaveAction } from "./actions";

/**
 * Approve or decline one request. The optional reason is sent with either button and
 * the requester sees it, in their email and on their dashboard. A refused decision keeps
 * the reason as typed.
 */
export function DecisionForm({ requestId }: { requestId: string }) {
  const { state, dispatch, pending, onSubmit } = useFormAction(decideLeaveAction, IDLE);
  const outcome = useRef<HTMLParagraphElement>(null);

  // The outcome replaces the form, including the button that had focus.
  useEffect(() => {
    if (state.status === "success") outcome.current?.focus();
  }, [state]);

  if (state.status === "success") {
    return (
      <p ref={outcome} tabIndex={-1} role="status" className="text-sm font-medium text-accent outline-none">
        {state.message}
      </p>
    );
  }

  return (
    <form action={dispatch} onSubmit={onSubmit} className="space-y-3">
      {/* Enter in the reason field submits with the form's first submit button. This one is
          disabled, so Enter does nothing rather than approving a request someone was
          writing a decline reason for. */}
      <button type="submit" disabled hidden aria-hidden tabIndex={-1} />
      <input type="hidden" name="requestId" value={requestId} />
      <TextField label="Reason" optional name="reason" maxLength={NOTE_MAX_LENGTH} />
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" name="decision" value="approve" aria-disabled={pending} className={buttonClass("primary", "sm")}>
          Approve
        </button>
        <button type="submit" name="decision" value="reject" aria-disabled={pending} className={buttonClass("outline", "sm")}>
          Decline
        </button>
        {state.status === "error" && <ErrorMessage className="text-sm">{state.message}</ErrorMessage>}
      </div>
    </form>
  );
}
