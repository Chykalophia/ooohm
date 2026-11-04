"use client";

import { useActionState, useEffect, useRef, useTransition } from "react";

/** A server action as forms call it: the previous state and the submitted fields in, the next state out. */
export type StateAction<S> = (prev: Awaited<S>, formData: FormData) => Promise<S>;

/** The part of a state this hook reads to mark fields: a refused submit can name them. */
type MaybeFieldErrors = { status?: unknown; fields?: unknown };

/**
 * Binds a form to a server action without React's automatic form reset, so a refused
 * submit keeps what the person typed. The submit button that was pressed is included in
 * the data, so its `name` and `value` reach the action (Approve or Decline). While a submit
 * is on its way, mark the buttons `aria-disabled={pending}` (not `disabled`, which would
 * drop their focus); further submits are ignored.
 *
 * When a refusal names `fields`, those controls get `aria-invalid` (drawn in the danger
 * colour by `fieldClass`) and focus moves to the first, so a keyboard or screen reader
 * user lands on what to fix (WCAG 3.3.1). The marks clear on the next submit.
 *
 * Spread `onSubmit` onto the `<form>` and also pass `dispatch` as its `action`, which
 * keeps the form working before hydration.
 */
export function useFormAction<S>(action: StateAction<S>, initial: Awaited<S>) {
  const [state, dispatch, pending] = useActionState<S, FormData>(action, initial);
  const [, startTransition] = useTransition();
  const form = useRef<HTMLFormElement | null>(null);
  const marked = useRef<Element[]>([]);

  useEffect(() => {
    const s = state as MaybeFieldErrors;
    const names = s?.status === "error" && Array.isArray(s.fields) ? (s.fields as string[]) : [];
    const el = form.current;
    if (!el || names.length === 0) return;
    const controls = names
      .map((n) => el.elements.namedItem(n))
      .map((c) => (c instanceof RadioNodeList ? (c[0] as Element | undefined) : c))
      .filter((c): c is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement => c instanceof HTMLElement && "type" in c && c.type !== "hidden");
    for (const c of controls) c.setAttribute("aria-invalid", "true");
    marked.current = controls;
    controls[0]?.focus();
  }, [state]);

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // Buttons say they are busy with aria-disabled rather than disabled: a disabled button
    // drops keyboard focus to the page body. So a second submit is refused here instead.
    if (pending) return;
    form.current = e.currentTarget;
    for (const c of marked.current) c.removeAttribute("aria-invalid");
    marked.current = [];
    // The submit control that was used (a button or an input), so its name and value go along.
    const data = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter ?? null);
    startTransition(() => dispatch(data));
  };
  return { state, dispatch, pending, onSubmit };
}
