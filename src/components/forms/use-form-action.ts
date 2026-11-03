"use client";

import { useActionState, useTransition } from "react";

/** A server action as forms call it: the previous state and the submitted fields in, the next state out. */
export type StateAction<S> = (prev: Awaited<S>, formData: FormData) => Promise<S>;

/**
 * Binds a form to a server action without React's automatic form reset, so a refused
 * submit keeps what the person typed. The submit button that was pressed is included in
 * the data, so its `name` and `value` reach the action (Approve or Decline). While a submit
 * is on its way, mark the buttons `aria-disabled={pending}` (not `disabled`, which would
 * drop their focus); further submits are ignored.
 *
 * Spread `onSubmit` onto the `<form>` and also pass `dispatch` as its `action`, which
 * keeps the form working before hydration.
 */
export function useFormAction<S>(action: StateAction<S>, initial: Awaited<S>) {
  const [state, dispatch, pending] = useActionState<S, FormData>(action, initial);
  const [, startTransition] = useTransition();
  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // Buttons say they are busy with aria-disabled rather than disabled: a disabled button
    // drops keyboard focus to the page body. So a second submit is refused here instead.
    if (pending) return;
    const submitter = (e.nativeEvent as SubmitEvent).submitter;
    const data = new FormData(e.currentTarget, submitter instanceof HTMLButtonElement ? submitter : null);
    startTransition(() => dispatch(data));
  };
  return { state, dispatch, pending, onSubmit };
}
