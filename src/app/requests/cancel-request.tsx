"use client";

import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import { formatLeaveDates } from "@/lib/format";
import { ErrorMessage } from "@/components/forms/form-status";
import { type FormState, IDLE } from "@/components/forms/form-state";
import { cx, dangerButton, focusRing } from "@/components/ui/styles";
import { cancelLeaveAction } from "@/app/actions";

/** How long a cancel can be taken back before it is sent. */
const UNDO_SECONDS = 8;

const undoButton = cx(
  "inline-flex min-h-6 items-center rounded-md text-sm font-medium text-accent-ink underline-offset-4 hover:underline",
  focusRing,
);

/**
 * "Cancel request" for one of the person's own requests, wherever it is shown (the
 * dashboard, "Your requests", the request's own page), with undo instead of "Are you
 * sure?": a click starts an {@link UNDO_SECONDS}-second countdown with Undo, and the
 * cancel is sent only when it ends. Leaving the page during the countdown sends it at
 * once; if that last send never arrives (the tab closed mid-request), the request
 * simply stays, which is the safe way to fail. Focus moves to Undo, and back to Cancel
 * request after an undo.
 *
 * @param focusOnSuccess The element (with `tabIndex={-1}`) focus moves to once the
 *   request is cancelled: this action disappears with it.
 */
export function CancelRequest({
  request: r,
  focusOnSuccess,
}: {
  request: { id: string; startDate: string; endDate: string; dayPortion: "full" | "am" | "pm" };
  focusOnSuccess: string;
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const next = await cancelLeaveAction(prev, formData);
    if (next.status === "success") document.getElementById(focusOnSuccess)?.focus();
    return next;
  }, IDLE);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
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
      if (!alreadySent) startTransition(() => formAction(cancelData(r.id)));
    }, 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft, r.id, formAction]);

  // The id the countdown is for, read by the leave-the-page send below without making it
  // a dependency: a re-render must never count as leaving.
  const countingFor = useRef(r.id);
  useEffect(() => {
    countingFor.current = r.id;
  }, [r.id]);

  // Leaving during the countdown, for another page or by closing the tab, sends the cancel now.
  useEffect(() => {
    if (!counting) return;
    const sendNow = () => {
      if (settled.current) return;
      settled.current = true;
      void cancelLeaveAction(IDLE, cancelData(countingFor.current));
    };
    window.addEventListener("pagehide", sendNow);
    return () => {
      window.removeEventListener("pagehide", sendNow);
      sendNow();
    };
  }, [counting]);

  const start = () => {
    settled.current = false;
    setSecondsLeft(UNDO_SECONDS);
    // Cancel request is about to go; Undo takes its place and its focus.
    requestAnimationFrame(() => undoRef.current?.focus());
  };
  const undo = () => {
    settled.current = true;
    setSecondsLeft(null);
    requestAnimationFrame(() => cancelRef.current?.focus());
  };

  return (
    <div className="flex flex-wrap items-center gap-3 sm:justify-end">
      {state.status === "error" && <ErrorMessage className="text-sm">{state.message}</ErrorMessage>}
      {counting ? (
        <>
          <span role="status" className="text-sm text-muted">
            Cancelling<span aria-hidden> in {secondsLeft}s</span>
            {/* Announced once, not every second. */}
            <span className="sr-only"> in {UNDO_SECONDS} seconds. Undo keeps it.</span>
          </span>
          <button ref={undoRef} type="button" onClick={undo} className={undoButton}>
            Undo
          </button>
        </>
      ) : pending ? (
        <span role="status" className="text-sm text-muted">
          Cancelling…
        </span>
      ) : (
        <button
          ref={cancelRef}
          type="button"
          onClick={start}
          className={dangerButton}
          aria-label={`Cancel the request for ${formatLeaveDates(r.startDate, r.endDate, r.dayPortion)}`}
        >
          Cancel request
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
