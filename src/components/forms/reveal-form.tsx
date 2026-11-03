"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { CopyField } from "@/components/ui/copy-field";
import { cx, primaryButton, textLink } from "@/components/ui/styles";
import { FormStatus } from "./form-status";
import { KeepIt } from "./keep-it";
import { useConfirm } from "./use-confirm";
import { PendingLabel } from "@/components/ui/ooo-dots";
import { REVEAL_IDLE, type RevealState } from "./reveal-state";
import { type StateAction, useFormAction } from "./use-form-action";

export type RevealAction = StateAction<RevealState>;

/** The secret, once: a read-only field, a copy button, and what to do with it. */
function Revealed({
  state,
  label,
  note,
  hrefLabel,
}: {
  state: Extract<RevealState, { status: "revealed" }>;
  label: string;
  note: React.ReactNode;
  hrefLabel?: string;
}) {
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
        <Link href={state.href} className={cx(textLink, "text-sm font-medium text-accent-ink")}>
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
  const { asking: asked, ask, back, done, questionRef, openerRef } = useConfirm();
  // The question closes only once the action succeeded, as in InlineAction: closing it on
  // submit would unmount the focused "Yes", hide its pending label and lose the question
  // if the server refuses. On success the revealed value takes focus.
  const { state, dispatch, pending, onSubmit } = useFormAction<RevealState>(async (prev, formData) => {
    const next = await action(prev, formData);
    if (next.status !== "error") done();
    return next;
  }, REVEAL_IDLE);
  const asking = asked !== null;
  const fieldsKey = state.status === "revealed" ? state.id : "form";

  const revealed = state.status === "revealed" ? state : null;
  return (
    <div className="space-y-4">
      {revealed && <Revealed key={revealed.id} state={revealed} label={valueLabel} note={note} hrefLabel={hrefLabel} />}
      {!(revealed && hideFormOnReveal) && (
        <form action={dispatch} onSubmit={onSubmit} className={className}>
          <div key={fieldsKey} className={className}>
            {children}
          </div>
          {confirm && asking && (
            <p ref={questionRef} tabIndex={-1} className="text-sm outline-none">
              {confirm}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-4">
            {confirm && !asking ? (
              <button ref={openerRef("confirm")} type="button" onClick={() => ask("confirm")} className={buttonClassName}>
                {submitLabel}
              </button>
            ) : (
              <button type="submit" aria-disabled={pending} className={buttonClassName}>
                {pending ? <PendingLabel label={pendingLabel} /> : confirm ? (confirmLabel ?? "Yes") : submitLabel}
              </button>
            )}
            {confirm && asking && <KeepIt pending={pending} onBack={back} />}
            <FormStatus state={state} />
          </div>
        </form>
      )}
    </div>
  );
}
