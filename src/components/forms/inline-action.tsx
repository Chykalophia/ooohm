"use client";

import { useEffect, useRef, useState } from "react";
import { dangerButton, subtleButton } from "@/components/ui/styles";
import type { FormAction } from "./action-form";
import { type FormState, IDLE } from "./form-state";
import { FormStatus } from "./form-status";
import { useFormAction } from "./use-form-action";

/**
 * One quiet action on a record (archive, delete, cancel, move up), sent with hidden
 * fields. The result stays shown while the component stays mounted, even when the page
 * swaps `action`, `label` and `confirm` after a refresh (give it a stable `key` for
 * that). With `confirm`, the first click asks first: "Yes, …" sends it, "Keep it" backs
 * out. Focus moves to the question and back, so keyboard users never lose their place.
 */
export function InlineAction({
  action,
  fields,
  label,
  pendingLabel,
  confirm,
  confirmLabel,
  danger = false,
  className,
  confirmClassName,
  ariaLabel,
  showSuccess = true,
  focusResult = false,
  focusOnSuccess,
}: {
  action: FormAction;
  fields: Record<string, string>;
  label: React.ReactNode;
  pendingLabel: string;
  confirm?: string;
  confirmLabel?: string;
  danger?: boolean;
  className?: string;
  /** Style of the "Yes, …" button, when it should differ from the opener's (a quiet Cancel that confirms in red). */
  confirmClassName?: string;
  /** Names the action for screen readers when `label` alone is ambiguous ("Up", "Delete"). */
  ariaLabel?: string;
  showSuccess?: boolean;
  /**
   * Move focus to the result line after a success: for actions that change the page
   * around them (deactivate swaps itself for reactivate), so the outcome is read out and
   * focus does not land on the opposite action.
   */
  focusResult?: boolean;
  /**
   * Id of a stable element (with `tabIndex={-1}`) to focus after a success, for an action
   * that disappears with it (cancelling a request removes its own Cancel button), so focus
   * does not fall back to the page body.
   */
  focusOnSuccess?: string;
}) {
  // Focus moves inside the action, not in an effect: the refresh that comes back with a
  // success can unmount this component in the same commit, and its effects with it.
  const run: FormAction = async (prev, formData) => {
    const next = await action(prev, formData);
    if (next.status === "success" && focusOnSuccess) document.getElementById(focusOnSuccess)?.focus();
    return next;
  };
  const { state, dispatch, pending, onSubmit } = useFormAction(run, IDLE);
  const result = useRef<HTMLParagraphElement>(null);
  // Asking lasts until the next result arrives: a new state object ends it.
  const [askedAt, setAskedAt] = useState<FormState | null>(null);
  const asking = askedAt === state;
  const question = useRef<HTMLParagraphElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const style = className ?? (danger ? dangerButton : subtleButton);

  useEffect(() => {
    if (asking) question.current?.focus();
  }, [asking]);
  useEffect(() => {
    if (focusResult && state.status === "success") result.current?.focus();
  }, [focusResult, state]);

  const hidden = Object.entries(fields).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />);
  const showOutcome = state.status === "error" || (showSuccess && state.status === "success");

  // One wrapper, and the outcome always its second child, so the result line stays
  // mounted (and focused) when a refresh swaps the opener for the form or back:
  // deactivate (asks first) turns into reactivate (does not), and back again.
  return (
    <div className="space-y-2">
      {confirm && !asking ? (
        <button ref={opener} type="button" onClick={() => setAskedAt(state)} className={style} aria-label={ariaLabel}>
          {label}
        </button>
      ) : (
        <form action={dispatch} onSubmit={onSubmit} className="space-y-2">
          {hidden}
          {confirm && (
            <p ref={question} tabIndex={-1} className="text-sm outline-none">
              {confirm}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-4">
            <button
              type="submit"
              disabled={pending}
              className={confirm ? (confirmClassName ?? style) : style}
              aria-label={confirm ? undefined : ariaLabel}
            >
              {pending ? pendingLabel : confirm ? (confirmLabel ?? "Yes") : label}
            </button>
            {confirm && (
              <button
                type="button"
                onClick={() => {
                  setAskedAt(null);
                  requestAnimationFrame(() => opener.current?.focus());
                }}
                className={subtleButton}
              >
                Keep it
              </button>
            )}
          </div>
        </form>
      )}
      {showOutcome && <FormStatus state={state} success={showSuccess} ref={focusResult ? result : undefined} />}
    </div>
  );
}
