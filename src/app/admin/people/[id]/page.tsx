import type { Metadata } from "next";
import Link from "next/link";
import { DELETION_GRACE_DAYS } from "@/domain/person-deletion";
import { formatInstantDate } from "@/lib/format";
import { getPersonDetail, getPersonFormOptions } from "@/server/services/admin-people";
import { getDeletionPreview } from "@/server/services/admin-people-deletion";
import { AdminShell } from "@/app/admin/admin-shell";
import { orNotFound, requireAdminPage } from "@/app/_lib/page-context";
import { ActionForm } from "@/components/forms/action-form";
import { InlineAction } from "@/components/forms/inline-action";
import { BackLink, Section } from "@/components/ui/section";
import { outlineButton } from "@/components/ui/styles";
import { ADD_LEAVE_FORM_ID } from "@/components/layout/anchors";
import { cancelDeletionAction, deactivateAction, reactivateAction, resendInviteAction, updatePersonAction } from "@/app/admin/people/actions";
import { BalanceList } from "@/components/leave/balance-list";
import { Blocked, DeletePersonDialog } from "@/app/admin/people/delete-person-dialog";
import { PersonFields } from "@/app/admin/people/person-fields";

export const metadata: Metadata = { title: "Person · Admin · OOOhm" };

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { actor, ctx, nav } = await requireAdminPage();
  const { id } = await params;
  const [detail, options] = await Promise.all([
    orNotFound(getPersonDetail(ctx, actor, id)),
    getPersonFormOptions(ctx, actor, id),
  ]);
  const { person, year, balances, timezone } = detail;
  const isSelf = person.id === actor.id;
  // Deleting is the step after deactivating, so only a deactivated person's page offers it.
  const deletion = person.isActive ? null : await getDeletionPreview(ctx, actor, person.id);
  const scrubDate = person.scrubScheduledAt ? formatInstantDate(person.scrubScheduledAt, timezone) : null;

  return (
    <AdminShell
      nav={nav}
      section="people"
      title={person.name || person.email}
      description={
        <>
          <span className="break-all">{person.email}</span>
          {!person.isActive && " · Deactivated: can't sign in"}
        </>
      }
    >
      <Section title="Details" surface className="space-y-5">
        <ActionForm action={updatePersonAction} submitLabel="Save changes" pendingLabel="Saving…">
          <input type="hidden" name="userId" value={person.id} />
          <PersonFields departments={options.departments} managers={options.managers} person={person} />
        </ActionForm>
      </Section>

      <Section
        title={`Balance for ${year}`}
        action={
          <div className="flex flex-wrap gap-2">
            {person.isActive && !isSelf && (
              <Link href={`/team/${person.id}#${ADD_LEAVE_FORM_ID}`} className={outlineButton}>
                Add time off
              </Link>
            )}
            <Link href={`/admin/people/${person.id}/allowances?year=${year}`} className={outlineButton}>
              Change allowances
            </Link>
          </div>
        }
      >
        {balances ? (
          <BalanceList year={year} items={balances.items} />
        ) : (
          <p className="text-muted">Balances aren&apos;t available: check the company&apos;s allowance policy.</p>
        )}
      </Section>

      <Section title="Access">
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
              variant={person.isActive ? "danger" : "outline"}
              confirm={
                person.isActive
                  ? "They'll be signed out and can't sign in again, and their calendar links stop working. Their requests stay. Requests waiting for their approval move to another approver."
                  : undefined
              }
              confirmLabel={person.isActive ? "Yes, deactivate" : undefined}
              focusResult
            />
          )}
          {scrubDate && (
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <p>
                  {deletion?.scrubWaiting ? `Deletion was due on ${scrubDate}, but it can't run yet.` : `Scheduled for deletion on ${scrubDate}.`}
                </p>
                <InlineAction action={cancelDeletionAction} fields={{ userId: person.id }} label="Undo" pendingLabel="Undoing…" />
              </div>
              {deletion?.scrubWaiting && <Blocked blockers={deletion.blockers} />}
            </div>
          )}
          {deletion && (
            <DeletePersonDialog
              // A new schedule state (scheduled, or undone) mounts a fresh dialog, so its mode
              // starts from the default for that state rather than the last choice.
              key={scrubDate ?? "none"}
              personId={person.id}
              confirmName={deletion.confirmName}
              blockers={deletion.blockers}
              blocked={deletion.blocked}
              describe={deletion.describe}
              deletionGrace={deletion.deletionGrace}
              graceDays={DELETION_GRACE_DAYS}
              scrubScheduledFor={scrubDate}
              exportHref={`/admin/people/${person.id}/export`}
            />
          )}
        </div>
      </Section>

      <BackLink href="/admin/people">Back to people</BackLink>
    </AdminShell>
  );
}
