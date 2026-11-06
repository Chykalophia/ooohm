"use client";

import { type FormAction } from "@/components/forms/action-form";
import { IDLE } from "@/components/forms/form-state";
import { FormStatus } from "@/components/forms/form-status";
import { Reveal } from "@/components/forms/reveal";
import { useFormAction } from "@/components/forms/use-form-action";
import { TextAreaField } from "@/components/ui/fields";
import { PendingLabel } from "@/components/ui/ooo-dots";
import { dangerOutlineButton } from "@/components/ui/styles";

/**
 * "Remove" on a teammate's approved time off, for their manager or an admin: a reason,
 * then the remove. It corrects the record (entered twice, or they worked after all), so
 * it sits behind a reveal and is never one click; the person is emailed the reason.
 *
 * On success the entry leaves its list, and this form with it, so focus moves to
 * `focusOnSuccess` (a heading that is always shown), as Cancel does on "Your requests".
 */
export function RemoveLeave({
  action,
  requestId,
  dates,
  maxLength,
  focusOnSuccess,
}: {
  action: FormAction;
  requestId: string;
  /** The leave's dates as shown, to name the button for screen readers. */
  dates: string;
  maxLength: number;
  focusOnSuccess: string;
}) {
  const { state, dispatch, pending, onSubmit } = useFormAction<Awaited<ReturnType<FormAction>>>(async (prev, formData) => {
    const next = await action(prev, formData);
    if (next.status === "success") document.getElementById(focusOnSuccess)?.focus();
    return next;
  }, IDLE);

  return (
    <Reveal label="Remove" ariaLabel={`Remove time off, ${dates}`}>
      <form action={dispatch} onSubmit={onSubmit} className="space-y-3">
        <input type="hidden" name="requestId" value={requestId} />
        <TextAreaField
          label="Why is it being removed?"
          hint="They're emailed this, and it's kept in the audit log. The days go back to their balance."
          name="reason"
          required
          rows={2}
          maxLength={maxLength}
        />
        <div className="flex flex-wrap items-center gap-4">
          <button type="submit" aria-disabled={pending} className={dangerOutlineButton}>
            {pending ? <PendingLabel label="Removing…" /> : "Remove time off"}
          </button>
          <FormStatus state={state} />
        </div>
      </form>
    </Reveal>
  );
}
