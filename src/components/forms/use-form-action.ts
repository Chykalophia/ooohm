"use client";

import { useActionState, useTransition } from "react";

/** A server action as forms call it: the previous state and the submitted fields in, the next state out. */
export type StateAction<S> = (prev: Awaited<S>, formData: FormData) => Promise<S>;

/**
 * Binds a form to a server action without React's automatic form reset, so a refused
 * submit keeps what the person typed. The submit button that was pressed is included in
 * the data, so its `name` and `value` reach the action (Approve or Decline).
 *
 * Spread `onSubmit` onto the `<form>` and also pass `dispatch` as its `action`, which
 * keeps the form working before hydration.
 */
export function useFormAction<S>(action: StateAction<S>, initial: Awaited<S>) {
  const [state, dispatch, pending] = useActionState<S, FormData>(action, initial);
  const [, startTransition] = useTransition();
  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter;
    const data = new FormData(e.currentTarget, submitter instanceof HTMLButtonElement ? submitter : null);
    startTransition(() => dispatch(data));
  };
  return { state, dispatch, pending, onSubmit };
}
