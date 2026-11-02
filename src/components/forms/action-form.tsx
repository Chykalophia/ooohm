"use client";

import { useState } from "react";
import { primaryButton } from "@/components/ui/styles";
import { type FormState, IDLE, nextFormKey } from "./form-state";
import { FormStatus } from "./form-status";
import { type StateAction, useFormAction } from "./use-form-action";

/** A server action behind a form whose result is a calm message (see {@link FormState}). */
export type FormAction = StateAction<FormState>;

/**
 * A form whose fields are rendered by the (server) page and passed as children, with its
 * submit button and {@link FormStatus} beside it.
 *
 * @param resetOnSuccess Clear the fields after a successful submit (create forms).
 *   Edit forms keep their values; the page refreshes with what was saved.
 */
export function ActionForm({
  action,
  submitLabel,
  pendingLabel,
  resetOnSuccess = false,
  className = "space-y-5",
  buttonClassName = primaryButton,
  children,
}: {
  action: FormAction;
  submitLabel: string;
  pendingLabel: string;
  resetOnSuccess?: boolean;
  className?: string;
  buttonClassName?: string;
  children: React.ReactNode;
}) {
  const { state, dispatch, pending, onSubmit } = useFormAction(action, IDLE);
  const [resetKey, setResetKey] = useState("form");
  const key = resetOnSuccess ? nextFormKey(resetKey, state) : resetKey;
  if (key !== resetKey) setResetKey(key);

  return (
    <form action={dispatch} onSubmit={onSubmit} className={className}>
      <div key={key} className={className}>
        {children}
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <button type="submit" aria-disabled={pending} className={buttonClassName}>
          {pending ? pendingLabel : submitLabel}
        </button>
        <FormStatus state={state} />
      </div>
    </form>
  );
}
