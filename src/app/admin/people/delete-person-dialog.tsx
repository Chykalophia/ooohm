"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { confirmationMatches, type DeletionBlockers, type DeletionMode } from "@/domain/person-deletion";
import { IDLE } from "@/components/forms/form-state";
import { ErrorMessage } from "@/components/forms/form-status";
import { useFormAction } from "@/components/forms/use-form-action";
import { PendingLabel } from "@/components/ui/ooo-dots";
import { type DeleteState, deletePersonAction } from "@/app/admin/people/actions";
import { cx, dangerButton, dangerOutlineButton, field, nativeCheck, outlineButton, subtleButton, textLink } from "@/components/ui/styles";

export interface DeletePersonDialogProps {
  personId: string;
  /** What the admin types to confirm: the person's name as shown. */
  confirmName: string;
  blockers: DeletionBlockers;
  blocked: boolean;
  describe: Record<DeletionMode, { removes: string[]; keeps: string[] }>;
  /** The company's grace option: a full scrub is scheduled `graceDays` ahead instead of run. */
  deletionGrace: boolean;
  graceDays: number;
  /** When a full scrub is already scheduled, its date as the page shows it; otherwise `null`. */
  scrubScheduledFor: string | null;
  exportHref: string;
}

/** What has to change before a person can be deleted, with links to the people and requests to sort out. */
export function Blocked({ blockers }: { blockers: DeletionBlockers }) {
  const n = blockers.reports.length;
  return (
    <div className="space-y-3">
      <p>Before they can be deleted:</p>
      <ul className="list-disc space-y-2 pl-5">
        {blockers.stillActive && <li>Deactivate them first. Deleting takes two steps, so nobody is removed by accident.</li>}
        {n > 0 && (
          <li>
            {n === 1 ? "One person reports" : `${n} people report`} to them. Give {n === 1 ? "them" : "each of them"} another manager:
            <ul className="mt-1 space-y-1">
              {blockers.reports.map((r) => (
                <li key={r.id}>
                  <Link href={`/admin/people/${r.id}`} className={textLink}>
                    {r.name}
                  </Link>
                </li>
              ))}
            </ul>
          </li>
        )}
        {blockers.pendingApprovals > 0 && (
          <li>
            {blockers.pendingApprovals === 1 ? "One request is" : `${blockers.pendingApprovals} requests are`} waiting for their decision. Decide{" "}
            {blockers.pendingApprovals === 1 ? "it" : "them"} in{" "}
            <Link href="/approvals" className={textLink}>
              Approvals
            </Link>{" "}
            first.
          </li>
        )}
        {blockers.lastAdmin && <li>They&apos;re the only admin. Make someone else an admin first.</li>}
      </ul>
    </div>
  );
}

/**
 * The "Delete…" action on a deactivated person's page: a modal dialog with the two modes
 * (full scrub preselected), what each removes (counted from the database), a link to
 * download their records first, the type-the-name confirmation and a destructive button
 * that stays off until the name matches. When something blocks the delete, the dialog
 * lists what to sort out first instead of the form.
 */
export function DeletePersonDialog(props: DeletePersonDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { state, pending, onSubmit } = useFormAction<DeleteState>(deletePersonAction, IDLE);
  // With the grace option on, a scheduled scrub only waits: asking again would change
  // nothing, so the one thing left to choose is keeping records (which runs at once).
  const scrubScheduled = props.deletionGrace && props.scrubScheduledFor !== null;
  const [mode, setMode] = useState<DeletionMode>(scrubScheduled ? "records_kept" : "scrubbed");
  const [typed, setTyped] = useState("");
  const matches = confirmationMatches(typed, { name: props.confirmName, email: props.confirmName });
  const schedules = mode === "scrubbed" && props.deletionGrace;

  useEffect(() => {
    if (state.status === "error") dialog.current?.querySelector<HTMLElement>("[role=alert]")?.focus();
  }, [state]);

  const { removes, keeps } = props.describe[mode];
  // Something can start blocking after the page loaded (a request routed to them); the
  // refusal then brings the current blockers, listed in place of the form.
  const blockers = state.status === "blocked" ? state.blockers : props.blocked ? props.blockers : null;

  return (
    <>
      <button type="button" onClick={() => dialog.current?.showModal()} className={dangerButton}>
        Delete…
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-2xl border border-border bg-surface p-0 text-foreground shadow-xl backdrop:bg-black/40"
      >
        <div className="max-h-[85vh] space-y-5 overflow-y-auto p-6">
          <h2 id={titleId} className="text-lg font-semibold tracking-tight">
            Delete {props.confirmName}?
          </h2>

          {blockers ? (
            <>
              <Blocked blockers={blockers} />
              <button type="button" onClick={() => dialog.current?.close()} className={outlineButton}>
                Close
              </button>
            </>
          ) : (
            <form onSubmit={onSubmit} className="space-y-5">
              <input type="hidden" name="userId" value={props.personId} />
              <fieldset className="space-y-3">
                <legend className="sr-only">How to delete them</legend>
                <label className="flex cursor-pointer gap-3 rounded-lg border border-border p-3 has-[:checked]:border-accent has-[:disabled]:cursor-default has-[:disabled]:opacity-70">
                  <input
                    type="radio"
                    name="mode"
                    value="scrubbed"
                    checked={mode === "scrubbed"}
                    onChange={() => setMode("scrubbed")}
                    disabled={scrubScheduled}
                    className={cx("mt-1", nativeCheck)}
                  />
                  <span className="space-y-1">
                    <span className="block font-medium">Remove everything</span>
                    <span className="block text-sm text-muted">
                      Nothing about them stays in OOOhm. Approvals they made on other people&apos;s leave stay, under &ldquo;Former employee&rdquo;.
                      {scrubScheduled
                        ? ` Already scheduled for ${props.scrubScheduledFor}; undo it on this page if you change your mind.`
                        : props.deletionGrace && ` It runs in ${props.graceDays} days; you can undo it until then.`}
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer gap-3 rounded-lg border border-border p-3 has-[:checked]:border-accent">
                  <input
                    type="radio"
                    name="mode"
                    value="records_kept"
                    checked={mode === "records_kept"}
                    onChange={() => setMode("records_kept")}
                    className={cx("mt-1", nativeCheck)}
                  />
                  <span className="space-y-1">
                    <span className="block font-medium">Remove their account, keep their records</span>
                    <span className="block text-sm text-muted">
                      Their sign-in and email go. Their leave, balances, approvals and audit entries stay under &ldquo;{props.confirmName} (deleted)&rdquo;, and their
                      email can be invited again as a new account.
                    </span>
                  </span>
                </label>
              </fieldset>

              <div className="space-y-2 text-sm" aria-live="polite">
                <p className="font-medium">This removes:</p>
                <ul className="list-disc space-y-1 pl-5">
                  {removes.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                {keeps.length > 0 && (
                  <>
                    <p className="font-medium">This keeps:</p>
                    <ul className="list-disc space-y-1 pl-5">
                      {keeps.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>

              <p className="text-sm">
                <a href={props.exportHref} download className={textLink}>
                  Download their records first
                </a>{" "}
                <span className="text-muted">(a CSV of their leave, balances and audit entries)</span>
              </p>

              <div className="space-y-1.5">
                <label htmlFor={`${titleId}-confirm`} className="block text-sm font-medium">
                  Type <span className="font-semibold">{props.confirmName}</span> to confirm
                </label>
                <input
                  id={`${titleId}-confirm`}
                  name="confirmName"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  className={field}
                />
              </div>

              <p className="text-xs text-muted">
                This can&apos;t be undone{schedules ? " once it runs" : ""}. Webhooks already delivered (or on their way) to other systems can&apos;t be
                recalled, backups keep data until they rotate out (after the configured backup retention, 30 days by default; on Vercel,
                your database provider&apos;s restore window), and a downloaded CSV is outside OOOhm. Text mentioning them by first name
                only, or by a name a colleague shares, stays as written.
              </p>

              {state.status === "error" && (
                <ErrorMessage as="p" focusable className="text-sm">
                  {state.message}
                </ErrorMessage>
              )}

              <div className="flex flex-wrap items-center gap-4">
                <button type="submit" disabled={!matches || pending} className={dangerOutlineButton}>
                  {pending ? <PendingLabel label="Deleting…" /> : schedules ? `Delete in ${props.graceDays} days` : "Delete permanently"}
                </button>
                <button type="button" onClick={() => dialog.current?.close()} className={subtleButton}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      </dialog>
    </>
  );
}
