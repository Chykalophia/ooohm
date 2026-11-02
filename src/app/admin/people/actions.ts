"use server";

import { z } from "zod";
import { ROLES } from "@/domain/actor";
import { NOTE_MAX_LENGTH } from "@/domain/leave-request";
import { EMAIL_MAX_LENGTH, PERSON_NAME_MAX_LENGTH } from "@/domain/people";
import { isDomainError } from "@/domain/errors";
import { DELETION_MODES, type DeletionBlockers, type DeletionMode, deletionBlockersOf } from "@/domain/person-deletion";
import { setAllowanceOverride } from "@/server/services/admin-allowances";
import { deactivatePerson, invitePerson, reactivatePerson, resendInvite, updatePerson } from "@/server/services/admin-people";
import { cancelScheduledDeletion, deletePerson } from "@/server/services/admin-people-deletion";
import type { FormState } from "@/app/form-state";
import { adminAction, adminActionThenGo, formFields } from "@/app/admin/admin-action";
import { deactivationMessage } from "@/app/admin/people/deactivation-message";

const personFields = {
  name: formFields.text(PERSON_NAME_MAX_LENGTH * 2),
  role: z.enum(ROLES),
  departmentId: formFields.optionalId,
  managerId: formFields.optionalId,
  canSelfApprove: formFields.checkbox,
};

const inviteSchema = z.object({ email: formFields.text(EMAIL_MAX_LENGTH + 20), ...personFields });
const editSchema = z.object({ userId: formFields.id, ...personFields });
const personSchema = z.object({ userId: formFields.id });

const INVITE_MESSAGES = {
  already_exists: "That email can't be invited. If they're already here, find them in People.",
  invalid_input: "Check the email and name, then try again.",
  rate_limited: "That's a lot of invites for one hour. Try again later.",
};

const PERSON_MESSAGES = {
  not_found: "That person isn't in your company.",
  forbidden: "Only admins can do that.",
};

/** Invite page: creates the person and emails them a sign-in link. */
export async function inviteAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "person_invite",
    formData,
    inviteSchema,
    async (ctx, actor, input) => {
      const person = await invitePerson(ctx, actor, input);
      return `Invited. ${person.email} will get an email with a sign-in link.`;
    },
    INVITE_MESSAGES,
  );
}

/** Person page: saves name, department, manager, role and self-approval. */
export async function updatePersonAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "person_update",
    formData,
    editSchema,
    async (ctx, actor, { userId, ...input }) => {
      const { requestsReassigned: n } = await updatePerson(ctx, actor, userId, input);
      return n === 0 ? "Saved." : `Saved. ${n} pending ${n === 1 ? "request" : "requests"} moved to another approver.`;
    },
    PERSON_MESSAGES,
  );
}

export async function resendInviteAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "person_resend_invite",
    formData,
    personSchema,
    async (ctx, actor, { userId }) => {
      const person = await resendInvite(ctx, actor, userId);
      return `Sent. ${person.email} will get a new sign-in link.`;
    },
    { ...PERSON_MESSAGES, forbidden: "Reactivate them before sending a link.", rate_limited: INVITE_MESSAGES.rate_limited },
  );
}

export async function deactivateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "person_deactivate",
    formData,
    personSchema,
    async (ctx, actor, { userId }) => {
      return deactivationMessage(await deactivatePerson(ctx, actor, userId));
    },
    PERSON_MESSAGES,
  );
}

export async function reactivateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "person_reactivate",
    formData,
    personSchema,
    async (ctx, actor, { userId }) => {
      await reactivatePerson(ctx, actor, userId);
      return "Reactivated. They can sign in again.";
    },
    PERSON_MESSAGES,
  );
}

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
      try {
        const outcome = await deletePerson(ctx, actor, userId, { mode, confirmName });
        if (outcome.outcome === "deleted") return `/admin/people?notice=${outcome.mode}`;
        return `/admin/people?inactive=1&notice=${outcome.alreadyScheduled ? "already_scheduled" : "scheduled"}`;
      } catch (err) {
        if (isDomainError(err)) refused.blockers = deletionBlockersOf(err);
        throw err;
      }
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
    async (ctx, actor, { userId }) => {
      const cancelled = await cancelScheduledDeletion(ctx, actor, userId);
      return cancelled ? "Undone. They stay, deactivated." : "Nothing was scheduled.";
    },
    PERSON_MESSAGES,
  );
}

const allowanceSchema = z.object({
  userId: formFields.id,
  leaveTypeId: formFields.id,
  year: z.coerce.number().int(),
  days: formFields.number,
  adjustmentDays: formFields.number,
  reason: formFields.text(NOTE_MAX_LENGTH * 2),
});

/** Allowances page: sets one person's allowance for one leave type and year. */
export async function allowanceAction(_prev: FormState, formData: FormData): Promise<FormState> {
  return adminAction(
    "allowance_override",
    formData,
    allowanceSchema,
    async (ctx, actor, input) => {
      const { changed } = await setAllowanceOverride(ctx, actor, input);
      return changed ? "Saved." : "Those are already the amounts, so nothing changed and nothing was recorded.";
    },
    {
      ...PERSON_MESSAGES,
      invalid_input: "Days go from 0 to 366 in steps of 0.1, and a reason is required. Years before last year can't be changed.",
    },
  );
}
