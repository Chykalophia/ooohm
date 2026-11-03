"use client";

import { useEffect, useRef } from "react";
import { dangerButton, outlineButton, primaryButton, subtleButton } from "@/components/ui/styles";
import type { FormAction } from "./action-form";
import { IDLE } from "./form-state";
import { KeepIt } from "./keep-it";
import { FormStatus } from "./form-status";
import { useConfirm } from "./use-confirm";
import { useFormAction } from "./use-form-action";

const VARIANT = {
  /** A quiet text action (the default). */
  subtle: subtleButton,
  /** A quiet text action that removes or switches something off. */
  danger: dangerButton,
  outline: outlineButton,
  /** The page's main action, when it is a one-click action (Send test event). */
  primary: primaryButton,
} as const;

export type InlineActionVariant = keyof typeof VARIANT;

/**
 * One quiet action on a record (archive, delete, cancel), sent with hidden
 * fields. The result stays shown while the component stays mounted, even when the page
 * swaps `action`, `label` and `confirm` after a refresh (give it a stable `key` for
 * that). With `confirm`, the first click asks first (see {@link useConfirm}); the
 * question stays up after a refusal, so the person can read why and try again or back
 * out without losing their place.
 *
 * Without `confirm` or `focusOnSuccess`, the form posts the server action directly, so
 * it also works before the page's JavaScript has loaded.
 */
export function InlineAction({
  action,
  fields,
  label,
  pendingLabel,
  confirm,
  confirmLabel,
  variant = "subtle",
  confirmVariant = variant,
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
  variant?: InlineActionVariant;
  /** Style of the "Yes, …" button, when it should differ from the opener's (a quiet Cancel that confirms in red). */
  confirmVariant?: InlineActionVariant;
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
  const { asking: asked, ask, back, done, questionRef, openerRef } = useConfirm();
  // Work after a success happens inside the action, not in an effect: the refresh that
  // comes back with it can unmount this component in the same commit.
  const wrapped: FormAction = async (prev, formData) => {
    const next = await action(prev, formData);
    if (next.status === "success") {
      done();
      if (focusOnSuccess) document.getElementById(focusOnSuccess)?.focus();
    }
    return next;
  };
  const { state, dispatch, pending, onSubmit } = useFormAction(confirm || focusOnSuccess ? wrapped : action, IDLE);
  const result = useRef<HTMLParagraphElement>(null);
  const asking = Boolean(confirm) && asked !== null;

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
        <button ref={openerRef("confirm")} type="button" onClick={() => ask("confirm")} className={VARIANT[variant]} aria-label={ariaLabel}>
          {label}
        </button>
      ) : (
        <form action={dispatch} onSubmit={onSubmit} className="space-y-2">
          {hidden}
          {confirm && (
            <p ref={questionRef} tabIndex={-1} className="text-sm outline-none">
              {confirm}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-4">
            <button
              type="submit"
              aria-disabled={pending}
              className={VARIANT[confirm ? confirmVariant : variant]}
              aria-label={confirm ? undefined : ariaLabel}
            >
              {pending ? pendingLabel : confirm ? (confirmLabel ?? "Yes") : label}
            </button>
            {confirm && <KeepIt pending={pending} onBack={back} />}
          </div>
        </form>
      )}
      {showOutcome && <FormStatus state={state} success={showSuccess} ref={focusResult ? result : undefined} />}
    </div>
  );
}
