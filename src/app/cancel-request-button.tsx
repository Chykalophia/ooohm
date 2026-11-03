"use client";

import { useActionState, useState } from "react";
import { cancelLeaveAction } from "./actions";
import { type FormState, IDLE } from "./form-state";

/**
 * Two-step cancel, so approved time off is never dropped by a stray click.
 *
 * @param focusAfterCancel Id of a stable element (with `tabIndex={-1}`) that receives
 *   focus after a successful cancel, since this button then disappears with the row's
 *   cancellable state and focus would otherwise fall back to the page body.
 */
export function CancelRequestButton({ requestId, focusAfterCancel }: { requestId: string; focusAfterCancel: string }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const next = await cancelLeaveAction(prev, formData);
    if (next.status === "success") document.getElementById(focusAfterCancel)?.focus();
    return next;
  }, IDLE);
  const [confirming, setConfirming] = useState(false);

  const subtle = "rounded-md text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink";

  return (
    <div className="flex flex-wrap items-center justify-end gap-3">
      {state.status === "error" && (
        <span role="alert" className="text-sm text-red-700 dark:text-red-400">
          {state.message}
        </span>
      )}
      {confirming ? (
        <form action={formAction} className="flex items-center gap-3">
          <input type="hidden" name="requestId" value={requestId} />
          <button type="submit" disabled={pending} className={`${subtle} font-medium text-red-700 dark:text-red-400 disabled:opacity-60`}>
            {pending ? "Cancelling…" : "Yes, cancel it"}
          </button>
          <button type="button" onClick={() => setConfirming(false)} className={`${subtle} text-muted hover:text-foreground`}>
            Keep it
          </button>
        </form>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} className={`${subtle} text-muted hover:text-foreground`}>
          Cancel
        </button>
      )}
    </div>
  );
}
