"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { type FormState, IDLE, nextFormKey } from "@/app/form-state";
import { dangerButton, primaryButton, subtleButton } from "@/app/styles";

export type AdminAction = (prev: FormState, formData: FormData) => Promise<FormState>;

/**
 * Submits through the action without React's automatic form reset, so a refused save
 * keeps what the admin typed. The submitter is included, so a button's name and value
 * reach the action.
 */
function useAdminAction(action: AdminAction) {
  const [state, dispatch, pending] = useActionState<FormState, FormData>(action, IDLE);
  const [, startTransition] = useTransition();
  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter;
    const data = new FormData(e.currentTarget, submitter instanceof HTMLButtonElement ? submitter : null);
    startTransition(() => dispatch(data));
  };
  return { state, dispatch, pending, onSubmit };
}

function Outcome({ state, success, ref }: { state: FormState; success: boolean; ref?: React.Ref<HTMLParagraphElement> }) {
  return (
    <p ref={ref} tabIndex={ref ? -1 : undefined} aria-live="polite" className="min-h-5 text-sm outline-none">
      {state.status === "success" && success && <span className="text-accent-ink">{state.message}</span>}
      {state.status === "error" && (
        <span role="alert" className="text-red-700 dark:text-red-400">
          {state.message}
        </span>
      )}
    </p>
  );
}

/**
 * A form whose fields are rendered by the (server) page and passed as children. Shows
 * the action's calm success or error message beside the submit button.
 *
 * @param resetOnSuccess Clear the fields after a successful submit (create forms).
 *   Edit forms keep their values; the page refreshes with what was saved.
 */
export function AdminForm({
  action,
  submitLabel,
  pendingLabel,
  resetOnSuccess = false,
  className = "space-y-5",
  buttonClassName = primaryButton,
  children,
}: {
  action: AdminAction;
  submitLabel: string;
  pendingLabel: string;
  resetOnSuccess?: boolean;
  className?: string;
  buttonClassName?: string;
  children: React.ReactNode;
}) {
  const { state, dispatch, pending, onSubmit } = useAdminAction(action);
  const [resetKey, setResetKey] = useState("form");
  const key = resetOnSuccess ? nextFormKey(resetKey, state) : resetKey;
  if (key !== resetKey) setResetKey(key);

  return (
    <form action={dispatch} onSubmit={onSubmit} className={className}>
      <div key={key} className={className}>
        {children}
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <button type="submit" disabled={pending} className={buttonClassName}>
          {pending ? pendingLabel : submitLabel}
        </button>
        <Outcome state={state} success />
      </div>
    </form>
  );
}

/**
 * One quiet action on a record (archive, delete, deactivate, move up), sent with hidden
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
  ariaLabel,
  showSuccess = true,
  focusResult = false,
}: {
  action: AdminAction;
  fields: Record<string, string>;
  label: React.ReactNode;
  pendingLabel: string;
  confirm?: string;
  confirmLabel?: string;
  danger?: boolean;
  className?: string;
  /** Names the action for screen readers when `label` alone is ambiguous ("Up", "Delete"). */
  ariaLabel?: string;
  showSuccess?: boolean;
  /**
   * Move focus to the result line after a success: for actions that change the page
   * around them (deactivate swaps itself for reactivate), so the outcome is read out and
   * focus does not land on the opposite action.
   */
  focusResult?: boolean;
}) {
  const { state, dispatch, pending, onSubmit } = useAdminAction(action);
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
            <button type="submit" disabled={pending} className={style} aria-label={confirm ? undefined : ariaLabel}>
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
      {showOutcome && <Outcome state={state} success={showSuccess} ref={focusResult ? result : undefined} />}
    </div>
  );
}

/** Shows `children` (an edit form) only after "Change" is clicked, so a list stays calm. */
export function Reveal({
  label,
  ariaLabel,
  children,
  open: initiallyOpen = false,
}: {
  label: string;
  /** Names the button for screen readers when a list repeats `label` ("Change", "Rename"). */
  ariaLabel?: string;
  children: React.ReactNode;
  open?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={subtleButton} aria-expanded={false} aria-label={ariaLabel}>
        {label}
      </button>
    );
  }
  return (
    <div className="space-y-3">
      {children}
      <button type="button" onClick={() => setOpen(false)} className={subtleButton} aria-expanded aria-label={ariaLabel ? `Close: ${ariaLabel}` : undefined}>
        Close
      </button>
    </div>
  );
}
