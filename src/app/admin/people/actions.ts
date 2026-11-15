"use server";

import { z } from "zod";
import { EMAIL_MAX_LENGTH, PERSON_NAME_MAX_LENGTH } from "@/shared/kernel/names";
import { map } from "@/shared/lib/result";
import { cancelScheduledDeletion, DELETION_MODES, type DeletionBlockers, type DeletionMode, deletePerson, deletionBlockersOf } from "@/modules/people";
import type { FormState } from "@/components/forms/form-state";
import { adminAction, adminActionThenGo } from "@/app/admin/admin-action";
import { formFields } from "@/app/_lib/form-fields";
import { PERSON_MESSAGES, personSchema } from "@/app/admin/people/person-input";

const deleteSchema = z.object({
  userId: formFields.id,
  mode: z.enum(DELETION_MODES as [DeletionMode, ...DeletionMode[]]),
  confirmName: formFields.text(EMAIL_MAX_LENGTH + PERSON_NAME_MAX_LENGTH),
});

/** The delete dialog's state: a form state, or what now blocks the delete (it changed since the page loaded). */
export type DeleteState = FormState | { status: "blocked"; blockers: DeletionBlockers };

/**
 * Person page, delete dialog: deletes a deactivated person (or schedules a full scrub,
 * with the company's grace option on), then goes back to People, which says what happened.
 * When something blocks the delete, the dialog gets the blockers to list in place.
 */
export async function deletePersonAction(_prev: DeleteState, formData: FormData): Promise<DeleteState> {
  const refused: { blockers: DeletionBlockers | null } = { blockers: null };
  const state = await adminActionThenGo(
    "person_delete",
    formData,
    deleteSchema,
    async (ctx, actor, { userId, mode, confirmName }) => {
      const result = await deletePerson(ctx, actor, userId, { mode, confirmName });
      if (!result.ok) refused.blockers = deletionBlockersOf(result.error);
      return map(result, (outcome) =>
        outcome.outcome === "deleted"
          ? `/admin/people?notice=${outcome.mode}`
          : `/admin/people?inactive=1&notice=${outcome.alreadyScheduled ? "already_scheduled" : "scheduled"}`,
      );
    },
    { ...PERSON_MESSAGES, not_found: "That person isn't in your company, or was already deleted." },
  );
  return refused.blockers ? { status: "blocked", blockers: refused.blockers } : state;
}

/** People list and person page: undoes a scheduled full scrub. */
export async function cancelDeletionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "person_delete_cancel",
    formData,
    personSchema,
    async (ctx, actor, { userId }) =>
      map(await cancelScheduledDeletion(ctx, actor, userId), (cancelled) => (cancelled ? "Undone. They stay, deactivated." : "Nothing was scheduled.")),
    PERSON_MESSAGES,
  );
}
