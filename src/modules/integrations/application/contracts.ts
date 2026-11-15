import "server-only";
/**
 * The public contract of every event OOOhm sends (docs/api.md#events), as zod schemas:
 * the envelope, the `actor` that names who made a change, and the version 1 payload of
 * each event type. Payload schemas are strict, so a field the code adds without the
 * contract (and docs/api.md) saying so fails `tests/contracts`. Receivers are told to
 * ignore fields they don't know; this is OOOhm's own check that what it sends is what
 * it documents.
 */
import { z } from "zod";
import { ENVELOPE_VERSION } from "@/shared/kernel/event-envelope";
import {
  ADMIN_EVENT_TYPES,
  BALANCE_EVENT_TYPES,
  CALENDAR_FEED_EVENT_TYPES,
  IMPORT_EVENT_TYPES,
  INTEGRATION_EVENT_TYPES,
  LEAVE_EVENT_TYPES,
  LEAVE_REASSIGNED_EVENT_TYPE,
  LEAVE_RECOUNTED_EVENT_TYPE,
} from "@/shared/kernel/events";
import { PING_EVENT_TYPE } from "@/modules/integrations/domain/integrations";

const id = z.string().min(1);
const isoInstant = z.iso.datetime({ offset: false });
const calendarDate = z.iso.date();
/** A stable process identifier (`year_rollover`, `adapter_sync:gusto`); new ones may appear. */
const process = z.string().min(1);

const userActor = z.strictObject({ type: z.literal("user"), id, via: process.optional() });
const apiKeyActor = z.strictObject({ type: z.literal("api_key"), id, apiKeyId: id, via: process.optional() });
const systemActor = z.strictObject({ type: z.literal("system"), process, requestedBy: id.optional() });

/** `actor`: who or what made the change. */
export const eventActorSchema = z.discriminatedUnion("type", [userActor, apiKeyActor, systemActor]);

/** A change that may come from a system process: `actorId` is `null` then. */
const attributed = { actorId: id.nullable(), actor: eventActorSchema };
/** A change that always has a person behind it. */
const personAttributed = { actorId: id, actor: z.discriminatedUnion("type", [userActor, apiKeyActor]) };

export const envelopeSchema = z.strictObject({
  id,
  type: z.string().min(1),
  version: z.literal(ENVELOPE_VERSION),
  createdAt: isoInstant,
  companyId: id,
  data: z.unknown(),
});

const leavePayload = z.strictObject({
  requestId: id,
  userId: id,
  leaveTypeId: id,
  startDate: calendarDate,
  endDate: calendarDate,
  dayPortion: z.enum(["full", "am", "pm"]),
  days: z.number().nonnegative(),
  status: z.enum(["pending", "approved", "rejected", "cancelled"]),
  ...personAttributed,
});

const balancePayload = z.strictObject({
  allowanceId: id,
  userId: id,
  leaveTypeId: id,
  year: z.number().int(),
  days: z.number(),
  carriedOverDays: z.number(),
  adjustmentDays: z.number(),
  reason: z.enum(["carryover", "allowance_created", "admin_edit", "sync", "allowance_rule"]),
  ...attributed,
});

const userPayload = z.strictObject({
  userId: id,
  email: z.string(),
  name: z.string(),
  role: z.enum(["admin", "manager", "employee"]),
  departmentId: id.nullable(),
  levelId: id.nullable(),
  managerId: id.nullable(),
  canSelfApprove: z.boolean(),
  isActive: z.boolean(),
  ...attributed,
});

const deletionSchedulePayload = z.strictObject({ userId: id, scheduledFor: isoInstant, ...personAttributed });
const userDeletedPayload = z.strictObject({ userId: id, mode: z.enum(["scrubbed", "records_kept"]), deletedAt: isoInstant, ...attributed });

const departmentPayload = z.strictObject({
  departmentId: id,
  name: z.string(),
  managerId: id.nullable(),
  maxOff: z.number().int().positive().nullable(),
  ...attributed,
});
const levelPayload = z.strictObject({ levelId: id, name: z.string(), ...personAttributed });
const allowanceRulePayload = z.strictObject({
  ruleId: id,
  leaveTypeId: id,
  departmentId: id.nullable(),
  levelId: id.nullable(),
  days: z.number(),
  ...personAttributed,
});
const leaveTypePayload = z.strictObject({
  leaveTypeId: id,
  code: z.string(),
  name: z.string(),
  color: z.string(),
  isPaid: z.boolean(),
  countsAgainstAllowance: z.boolean(),
  defaultAllowanceDays: z.number().nullable(),
  carryoverEnabled: z.boolean(),
  carryoverMaxDays: z.number().nullable(),
  sortOrder: z.number().int(),
  archived: z.boolean(),
  ...personAttributed,
});
const holidayPayload = z.strictObject({ holidayId: id, date: calendarDate, name: z.string(), ...personAttributed });
const companyPayload = z.strictObject({
  companyId: id,
  name: z.string(),
  timezone: z.string(),
  workingDays: z.array(z.number().int().min(0).max(6)),
  allowancePolicy: z.string(),
  deletionGrace: z.boolean(),
  managersSeeDetails: z.boolean(),
  approvalMode: z.string(),
  colleagueVisibility: z.string(),
  departmentScoping: z.boolean(),
  theme: z.string(),
  accentColor: z.string().regex(/^#[0-9a-f]{6}$/i).nullable(),
  corners: z.string(),
  requestStyle: z.string(),
  layout: z.string(),
  logo: z
    .strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/), contentType: z.enum(["image/png", "image/jpeg"]), width: z.number().int(), height: z.number().int() })
    .nullable(),
  ...personAttributed,
});
const emailTemplatePayload = z.strictObject({ notificationType: z.string(), subject: z.string().nullable(), message: z.string().nullable(), ...personAttributed });

const calendarFeedPayload = z.strictObject({
  feedId: id,
  userId: id,
  kind: z.enum(["personal", "team"]),
  reason: z.enum(["regenerated", "turned_off", "deactivated"]).nullable(),
  ...personAttributed,
});

const webhookEndpointFields = {
  endpointId: id,
  /** Scheme and host only: never the path. */
  urlOrigin: z.string().regex(/^https?:\/\/[^/]+$/),
  description: z.string(),
  eventTypes: z.array(z.string()),
  enabled: z.boolean(),
  ...personAttributed,
};
const webhookEndpointPayload = z.strictObject(webhookEndpointFields);
const webhookEndpointUpdatedPayload = z.strictObject({ ...webhookEndpointFields, urlChanged: z.boolean() });
const webhookRedeliveredPayload = z.strictObject({ endpointId: id, deliveryId: id, eventId: id, eventType: z.string(), ...personAttributed });
const apiKeyPayload = z.strictObject({ apiKeyId: id, name: z.string(), prefix: z.string(), scopes: z.array(z.string()), ...personAttributed });

const importCompletedPayload = z.strictObject({
  importRunId: id,
  source: z.string(),
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  counts: z.strictObject({
    people: z.number().int(),
    departments: z.number().int(),
    leaveTypes: z.number().int(),
    holidays: z.number().int(),
    allowances: z.number().int(),
    leaveRequests: z.number().int(),
  }),
  mismatches: z.number().int().nonnegative(),
  ...personAttributed,
});

const pingPayload = z.strictObject({ endpointId: id, message: z.string() });

const each = <T extends z.ZodType>(types: readonly string[], schema: T) => types.map((t) => [t, schema] as const);
const A = ADMIN_EVENT_TYPES;
const I = INTEGRATION_EVENT_TYPES;

/** The version 1 payload (`data`) of every event type OOOhm sends, `ping` included. */
export const EVENT_PAYLOAD_SCHEMAS: Readonly<Record<string, z.ZodType>> = Object.fromEntries([
  ...each(Object.values(LEAVE_EVENT_TYPES), leavePayload),
  [LEAVE_REASSIGNED_EVENT_TYPE, leavePayload.extend({ previousApproverId: id.nullable(), approverId: id.nullable() })],
  [LEAVE_RECOUNTED_EVENT_TYPE, leavePayload.extend({ previousDays: z.number().nonnegative() })],
  ...each(Object.values(BALANCE_EVENT_TYPES), balancePayload),
  ...each([A.userCreated, A.userUpdated, A.userDeactivated, A.userReactivated, A.userInviteResent], userPayload),
  ...each([A.userDeletionScheduled, A.userDeletionCancelled], deletionSchedulePayload),
  [A.userDeleted, userDeletedPayload],
  ...each([A.departmentCreated, A.departmentRenamed, A.departmentDeleted, A.departmentManagerChanged, A.departmentLimitChanged], departmentPayload),
  ...each([A.levelCreated, A.levelRenamed, A.levelDeleted], levelPayload),
  ...each([A.allowanceRuleSet, A.allowanceRuleRemoved], allowanceRulePayload),
  ...each([A.leaveTypeCreated, A.leaveTypeUpdated, A.leaveTypeArchived, A.leaveTypeUnarchived, A.leaveTypeReordered], leaveTypePayload),
  ...each([A.holidayCreated, A.holidayRenamed, A.holidayDeleted], holidayPayload),
  [A.companyUpdated, companyPayload],
  ...each([A.emailTemplateUpdated, A.emailTemplateReset], emailTemplatePayload),
  ...each(Object.values(CALENDAR_FEED_EVENT_TYPES), calendarFeedPayload),
  ...each(
    [I.webhookEndpointCreated, I.webhookEndpointEnabled, I.webhookEndpointDisabled, I.webhookEndpointSecretRotated, I.webhookEndpointDeleted, I.webhookEndpointPinged],
    webhookEndpointPayload,
  ),
  [I.webhookEndpointUpdated, webhookEndpointUpdatedPayload],
  [I.webhookDeliveryRedelivered, webhookRedeliveredPayload],
  ...each([I.apiKeyCreated, I.apiKeyRevoked], apiKeyPayload),
  ...each(Object.values(IMPORT_EVENT_TYPES), importCompletedPayload),
  [PING_EVENT_TYPE, pingPayload],
]);

/** The headers of one webhook request (docs/api.md#the-request), names in lower case. */
export const webhookHeadersSchema = z.strictObject({
  "content-type": z.literal("application/json"),
  "user-agent": z.literal("OOOhm-Webhooks/1"),
  "ooohm-event-id": id,
  "ooohm-event-type": z.string().min(1),
  "ooohm-timestamp": z.string().regex(/^\d+$/),
  "ooohm-signature": z.string().regex(/^v1=[0-9a-f]{64}(,\s*v1=[0-9a-f]{64})*$/),
});

/**
 * Checks one envelope: its shape, and its `data` against the payload of its `type`.
 *
 * @returns The problems found, empty when it matches the contract.
 */
export function contractProblems(envelope: unknown): string[] {
  const outer = envelopeSchema.safeParse(envelope);
  if (!outer.success) return outer.error.issues.map((i) => `envelope.${i.path.join(".")}: ${i.message}`);
  const schema = EVENT_PAYLOAD_SCHEMAS[outer.data.type];
  if (!schema) return [`type: no contract for "${outer.data.type}"`];
  const inner = schema.safeParse(outer.data.data);
  return inner.success ? [] : inner.error.issues.map((i) => `data.${i.path.join(".")}: ${i.message}`);
}
