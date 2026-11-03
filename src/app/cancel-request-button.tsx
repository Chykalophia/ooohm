"use client";

import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import { cancelLeaveAction } from "./actions";
import { type FormState, IDLE } from "./form-state";

/** How long a cancel can be taken back before it is sent. */
const UNDO_SECONDS = 8;

/**
 * Cancel with undo instead of "Are you sure?": a click starts an {@link UNDO_SECONDS}
 * second countdown with an Undo button, and the cancel is sent only when it ends.
 * Leaving the page during the countdown sends it at once. If that last send never
 * arrives (the tab closed mid-request), the request simply stays, which is the safe
 * way to fail.
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
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  const counting = secondsLeft !== null;

  // Set once the countdown ends one way or another (sent, or undone), so it never sends twice.
  const settled = useRef(false);

  // The countdown: one tick a second, then the cancel goes out. `settled` is set before
  // the countdown state clears, so the leave-the-page effect below doesn't send it too.
  useEffect(() => {
    if (secondsLeft === null) return;
    const timer = setTimeout(() => {
      if (secondsLeft > 1) {
        setSecondsLeft(secondsLeft - 1);
        return;
      }
      const alreadySent = settled.current;
      settled.current = true;
      setSecondsLeft(null);
      if (!alreadySent) startTransition(() => formAction(cancelData(requestId)));
    }, 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft, requestId, formAction]);

  // Leaving during the countdown, for another page or by closing the tab, sends the cancel now.
  useEffect(() => {
    if (!counting) return;
    settled.current = false;
    const sendNow = () => {
      if (settled.current) return;
      settled.current = true;
      void cancelLeaveAction(IDLE, cancelData(requestId));
    };
    window.addEventListener("pagehide", sendNow);
    return () => {
      window.removeEventListener("pagehide", sendNow);
      sendNow();
    };
  }, [counting, requestId]);

  const subtle = "rounded-md text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink";

  const start = () => {
    setSecondsLeft(UNDO_SECONDS);
    // The Cancel button is about to go; Undo takes its place and its focus.
    requestAnimationFrame(() => undoButton.current?.focus());
  };
  const undo = () => {
    settled.current = true;
    setSecondsLeft(null);
    requestAnimationFrame(() => cancelButton.current?.focus());
  };

  return (
    <div className="flex flex-wrap items-center justify-end gap-3">
      {state.status === "error" && (
        <span role="alert" className="text-sm text-red-700 dark:text-red-400">
          {state.message}
        </span>
      )}
      {counting ? (
        <>
          <span role="status" className="text-sm text-muted">
            Cancelling<span aria-hidden> in {secondsLeft}s</span>
          </span>
          <button ref={undoButton} type="button" onClick={undo} className={`${subtle} font-medium text-accent-ink`}>
            Undo
          </button>
        </>
      ) : pending ? (
        <span role="status" className="text-sm text-muted">
          Cancelling…
        </span>
      ) : (
        <button ref={cancelButton} type="button" onClick={start} className={`${subtle} text-muted hover:text-foreground`}>
          Cancel
        </button>
      )}
    </div>
  );
}

function cancelData(requestId: string): FormData {
  const data = new FormData();
  data.set("requestId", requestId);
  return data;
}
