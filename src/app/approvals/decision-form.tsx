"use client";

import { useEffect, useRef, useState } from "react";
import { NOTE_MAX_LENGTH } from "@/domain/leave-request";
import { IDLE } from "@/components/forms/form-state";
import { ErrorMessage } from "@/components/forms/form-status";
import { useFormAction } from "@/components/forms/use-form-action";
import { TextField } from "@/components/ui/fields";
import { buttonClass } from "@/components/ui/styles";
import { decideLeaveAction } from "./actions";
import { DECLINE_EVENT } from "./approval-keys";

/** Which button decided a request. */
export type Decision = "approve" | "reject";

/**
 * Approve or decline one request. The optional reason is sent with either button and
 * the requester sees it, in their email and on their dashboard. A refused decision keeps
 * the reason as typed. The D shortcut ({@link DECLINE_EVENT}) moves focus to the reason
 * and makes Enter there decline; Escape takes that back.
 *
 * @param onDecided Called once the decision is saved, with the button that made it; the
 *   card around the form shows the outcome from then on.
 */
export function DecisionForm({ requestId, onDecided }: { requestId: string; onDecided: (decision: Decision) => void }) {
  const { state, dispatch, pending, onSubmit } = useFormAction(decideLeaveAction, IDLE);
  const form = useRef<HTMLFormElement>(null);
  const declineButton = useRef<HTMLButtonElement>(null);
  // The button of the submit on its way, so the outcome can say which way it went.
  const decision = useRef<Decision>("approve");
  // Set by the D shortcut: Enter in the reason field then declines.
  const [declining, setDeclining] = useState(false);

  useEffect(() => {
    if (state.status === "success") onDecided(decision.current);
  }, [state, onDecided]);

  useEffect(() => {
    const el = form.current;
    if (!el) return;
    const start = () => {
      setDeclining(true);
      (el.elements.namedItem("reason") as HTMLInputElement | null)?.focus();
    };
    el.addEventListener(DECLINE_EVENT, start);
    return () => el.removeEventListener(DECLINE_EVENT, start);
  }, [state]);

  // Before hydration (or if the card above does not take over) the saved outcome still shows.
  if (state.status === "success") {
    return <p className="text-sm font-medium text-accent-ink">{state.message}</p>;
  }

  return (
    <form
      ref={form}
      action={dispatch}
      onSubmit={(e) => {
        if (!pending) {
          const submitter = (e.nativeEvent as SubmitEvent).submitter;
          decision.current = submitter instanceof HTMLButtonElement && submitter.value === "reject" ? "reject" : "approve";
        }
        onSubmit(e);
      }}
      className="space-y-3"
    >
      {/* Enter in the reason field submits with the form's first submit button. This one is
          disabled, so Enter does nothing rather than approving a request someone was
          writing a decline reason for (unless D asked for a decline). */}
      <button type="submit" disabled hidden aria-hidden tabIndex={-1} />
      <input type="hidden" name="requestId" value={requestId} />
      <TextField
        label="Reason"
        optional
        name="reason"
        maxLength={NOTE_MAX_LENGTH}
        placeholder={declining ? "Why, then Enter to decline" : undefined}
        onKeyDown={(e) => {
          if (declining && e.key === "Enter") {
            e.preventDefault();
            declineButton.current?.click();
          } else if (declining && e.key === "Escape") {
            setDeclining(false);
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" name="decision" value="approve" aria-disabled={pending} className={buttonClass("primary", "sm")}>
          Approve
        </button>
        <button
          ref={declineButton}
          type="submit"
          name="decision"
          value="reject"
          aria-disabled={pending}
          className={buttonClass("outline", "sm")}
        >
          Decline
        </button>
        {state.status === "error" && <ErrorMessage className="text-sm">{state.message}</ErrorMessage>}
      </div>
    </form>
  );
}
