"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { CopyField } from "@/app/copy-field";
import { primaryButton, subtleButton, textLink } from "@/app/styles";
import { REVEAL_IDLE, type RevealState } from "./reveal-state";

export type RevealAction = (prev: RevealState, formData: FormData) => Promise<RevealState>;

/** The secret, once: a read-only field, a copy button, and what to do with it. */
function Revealed({ state, label, note, hrefLabel }: { state: Extract<RevealState, { status: "revealed" }>; label: string; note: React.ReactNode; hrefLabel?: string }) {
  const heading = useRef<HTMLParagraphElement>(null);

  useEffect(() => heading.current?.focus(), []);

  return (
    <div className="space-y-3 rounded-xl border border-accent/40 bg-accent/5 p-4">
      <p ref={heading} tabIndex={-1} className="text-sm font-medium outline-none">
        {state.message}
      </p>
      <CopyField label={label} value={state.value} />
      <p className="text-sm text-muted">{note}</p>
      {state.href && (
        <Link href={state.href} className={`${textLink} text-sm font-medium text-accent-ink`}>
          {hrefLabel ?? "Continue"}
        </Link>
      )}
    </div>
  );
}

/**
 * A form whose success reveals a secret exactly once (see {@link RevealState}). Fields
 * are passed as children by the server page. With `confirm`, the button asks first
 * ("Yes, …" sends it). With `hideFormOnReveal`, the form gives way to the secret (a
 * create-and-continue flow); otherwise the fields reset under it, ready for another.
 */
export function RevealForm({
  action,
  submitLabel,
  pendingLabel,
  valueLabel,
  note,
  hrefLabel,
  confirm,
  confirmLabel,
  hideFormOnReveal = false,
  buttonClassName = primaryButton,
  className = "space-y-5",
  children,
}: {
  action: RevealAction;
  submitLabel: string;
  pendingLabel: string;
  valueLabel: string;
  note: React.ReactNode;
  hrefLabel?: string;
  confirm?: string;
  confirmLabel?: string;
  hideFormOnReveal?: boolean;
  buttonClassName?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const [state, dispatch, pending] = useActionState<RevealState, FormData>(action, REVEAL_IDLE);
  const [, startTransition] = useTransition();
  const [asking, setAsking] = useState(false);
  const fieldsKey = state.status === "revealed" ? state.id : "form";

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setAsking(false);
    startTransition(() => dispatch(data));
  };

  const revealed = state.status === "revealed" ? state : null;
  return (
    <div className="space-y-4">
      {revealed && <Revealed key={revealed.id} state={revealed} label={valueLabel} note={note} hrefLabel={hrefLabel} />}
      {!(revealed && hideFormOnReveal) && (
        <form action={dispatch} onSubmit={onSubmit} className={className}>
          <div key={fieldsKey} className={className}>
            {children}
          </div>
          {confirm && asking && <p className="text-sm">{confirm}</p>}
          <div className="flex flex-wrap items-center gap-4">
            {confirm && !asking ? (
              <button type="button" onClick={() => setAsking(true)} className={buttonClassName}>
                {submitLabel}
              </button>
            ) : (
              <button type="submit" disabled={pending} className={buttonClassName}>
                {pending ? pendingLabel : confirm ? (confirmLabel ?? "Yes") : submitLabel}
              </button>
            )}
            {confirm && asking && (
              <button type="button" onClick={() => setAsking(false)} className={subtleButton}>
                Keep it
              </button>
            )}
            <p aria-live="polite" className="min-h-5 text-sm">
              {state.status === "error" && (
                <span role="alert" className="text-red-700 dark:text-red-400">
                  {state.message}
                </span>
              )}
            </p>
          </div>
        </form>
      )}
    </div>
  );
}
