"use client";

import Link from "next/link";
import { useActionState, useEffect, useId, useRef, useState, useTransition } from "react";
import { REVEAL_IDLE, type RevealState } from "./reveal-state";
import { primaryButton, subtleButton, textLink } from "./styles";

export type RevealAction = (prev: RevealState, formData: FormData) => Promise<RevealState>;

/** The secret, once: a read-only field, a copy button, and what to do with it. */
function Revealed({ state, label, note, hrefLabel }: { state: Extract<RevealState, { status: "revealed" }>; label: string; note: React.ReactNode; hrefLabel?: string }) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLParagraphElement>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "manual">("idle");

  useEffect(() => heading.current?.focus(), []);

  async function copyValue() {
    try {
      await navigator.clipboard.writeText(state.value);
      setCopy("copied");
    } catch {
      input.current?.select();
      setCopy("manual");
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-accent/40 bg-accent/5 p-4">
      <p ref={heading} tabIndex={-1} className="text-sm font-medium outline-none">
        {state.message}
      </p>
      <label htmlFor={inputId} className="block text-sm font-medium">
        {label}
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id={inputId}
          ref={input}
          readOnly
          value={state.value}
          onFocus={(e) => e.currentTarget.select()}
          className="w-full min-w-0 rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
        />
        <button type="button" onClick={copyValue} className={`${primaryButton} shrink-0`}>
          Copy
        </button>
      </div>
      <p aria-live="polite" className="min-h-5 text-sm text-accent">
        {copy === "copied" && "Copied."}
        {copy === "manual" && <span className="text-foreground">It&apos;s selected. Press Ctrl+C (⌘C on a Mac) to copy it.</span>}
      </p>
      <p className="text-sm text-muted">{note}</p>
      {state.href && (
        <Link href={state.href} className={`${textLink} text-sm font-medium text-accent`}>
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
