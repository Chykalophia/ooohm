import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isDomainError } from "@/domain/errors";
import { getPersonDetail, getPersonFormOptions } from "@/server/services/admin-people";
import { AdminShell, requireAdminPage } from "@/app/admin/admin-shell";
import { AdminForm, InlineAction } from "@/app/admin/forms";
import { card, outlineButton, subtleButton } from "@/app/admin/styles";
import { deactivateAction, reactivateAction, resendInviteAction, updatePersonAction } from "@/app/admin/people/actions";
import { BalanceList } from "@/app/admin/people/balance-list";
import { PersonFields } from "@/app/admin/people/person-fields";

export const metadata: Metadata = { title: "Person · Admin · OOOhm" };

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { actor, ctx, userName, approvals } = await requireAdminPage();
  const { id } = await params;
  const [detail, options] = await Promise.all([
    getPersonDetail(ctx, actor, id).catch((err: unknown) => {
      if (isDomainError(err, "not_found")) notFound();
      throw err;
    }),
    getPersonFormOptions(ctx, actor, id),
  ]);
  const { person, year, balances } = detail;
  const isSelf = person.id === actor.id;

  return (
    <AdminShell
      userName={userName}
      approvals={approvals}
      section="people"
      title={person.name || person.email}
      description={
        <>
          <span className="break-all">{person.email}</span>
          {!person.isActive && " · Deactivated: can't sign in"}
        </>
      }
    >
      <section aria-labelledby="details-heading" className={`${card} space-y-5`}>
        <h2 id="details-heading" className="text-lg font-semibold tracking-tight">
          Details
        </h2>
        <AdminForm action={updatePersonAction} submitLabel="Save changes" pendingLabel="Saving…">
          <input type="hidden" name="userId" value={person.id} />
          <PersonFields departments={options.departments} managers={options.managers} person={person} />
        </AdminForm>
      </section>

      <section aria-labelledby="balance-heading" className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="balance-heading" className="text-lg font-semibold tracking-tight">
            Balance for {year}
          </h2>
          <Link href={`/admin/people/${person.id}/allowances?year=${year}`} className={outlineButton}>
            Change allowances
          </Link>
        </div>
        {balances ? (
          <BalanceList year={year} items={balances.items} />
        ) : (
          <p className="text-muted">Balances aren&apos;t available: check the company&apos;s allowance policy.</p>
        )}
      </section>

      <section aria-labelledby="access-heading" className="space-y-4">
        <h2 id="access-heading" className="text-lg font-semibold tracking-tight">
          Access
        </h2>
        <div className="space-y-4">
          {person.isActive && (
            <InlineAction
              action={resendInviteAction}
              fields={{ userId: person.id }}
              label="Send a new sign-in link"
              pendingLabel="Sending…"
            />
          )}
          {/* One component for both directions, so the deactivation result (how many
              requests moved) stays on screen after the page swaps in "Reactivate". */}
          {!(person.isActive && isSelf) && (
            <InlineAction
              key="access"
              action={person.isActive ? deactivateAction : reactivateAction}
              fields={{ userId: person.id }}
              label={person.isActive ? "Deactivate" : "Reactivate"}
              pendingLabel={person.isActive ? "Deactivating…" : "Reactivating…"}
              danger={person.isActive}
              className={person.isActive ? undefined : outlineButton}
              confirm={
                person.isActive
                  ? "They'll be signed out and can't sign in again, and their calendar links stop working. Their requests stay. Requests waiting for their approval move to another approver."
                  : undefined
              }
              confirmLabel={person.isActive ? "Yes, deactivate" : undefined}
              focusResult
            />
          )}
        </div>
      </section>

      <p>
        <Link href="/admin/people" className={subtleButton}>
          Back to people
        </Link>
      </p>
    </AdminShell>
  );
}
