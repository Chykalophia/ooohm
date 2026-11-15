import "server-only";
import { z } from "zod";
import { ROLES } from "@/shared/kernel/actor";
import { PERSON_NAME_MAX_LENGTH } from "@/shared/kernel/names";
import { formFields } from "@/app/_lib/form-fields";

/** The fields the invite form and the person page share. */
export const personFields = {
  name: formFields.text(PERSON_NAME_MAX_LENGTH * 2),
  role: z.enum(ROLES),
  departmentId: formFields.optionalId,
  // Only on the form when the company has levels: absent leaves the person's level as it is.
  levelId: z
    .string()
    .max(100)
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null)),
  managerId: formFields.optionalId,
  canSelfApprove: formFields.checkbox,
};

/** One person, by id: the buttons on the person page and the People list. */
export const personSchema = z.object({ userId: formFields.id });

export const INVITE_MESSAGES = {
  already_exists: "That email can't be invited. If they're already here, find them in People.",
  invalid_input: "Check the email and name, then try again.",
  rate_limited: "That's a lot of invites for one hour. Try again later.",
};

export const PERSON_MESSAGES = {
  not_found: "That person isn't in your company.",
  forbidden: "Only admins can do that.",
};
