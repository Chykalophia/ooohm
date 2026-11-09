import type { CalendarDate } from "./calendar-date";
import type { FeedKind } from "./calendar-feed";
import type { Role } from "./actor";
import type { LogoType } from "./company-logo";
import type { ChangeProcess, ChangeSource, PersonChangeSource } from "./change-source";
import type { DayPortion, LeaveStatus } from "./leave-request";

/**
 * Who or what made a change, as every event payload publishes it in `actor` (added
 * within version 1). `id` is the person: the one who acted, or who created the API key.
 * `via` and `process` are stable identifiers (`year_rollover`, `adapter_sync:<id>`).
 * `requestedBy` (added within version 1) is the person who asked for a system run ahead
 * of time: the admin behind a scheduled scrub.
 */
export type EventActor =
  | { type: "user"; id: string; via?: ChangeProcess }
  | { type: "api_key"; id: string; apiKeyId: string; via?: ChangeProcess }
  | { type: "system"; process: ChangeProcess; requestedBy?: string };

/** An {@link EventActor} with a person behind it. */
export type PersonEventActor = Exclude<EventActor, { type: "system" }>;

/** The attribution fields of a payload whose change always has a person behind it. */
export interface PersonAttribution {
  /** The person who made the change; see `actor` for how. */
  actorId: string;
  actor: PersonEventActor;
}

/** The attribution fields of a payload whose change may come from a system process. */
export interface Attribution {
  /** The person who made the change, when there is one (`null` for a system process); see `actor`. */
  actorId: string | null;
  actor: EventActor;
}

/** A payload without its attribution fields, which `recordChange` adds from the change's source. */
export type Unattributed<T> = Omit<T, "actorId" | "actor">;

export function eventActor(source: PersonChangeSource): PersonEventActor;
export function eventActor(source: ChangeSource): EventActor;
export function eventActor(source: ChangeSource): EventActor {
  const via = source.kind !== "system" && source.via !== undefined ? { via: source.via } : {};
  if (source.kind === "user") return { type: "user", id: source.userId, ...via };
  if (source.kind === "api_key") return { type: "api_key", id: source.userId, apiKeyId: source.apiKeyId, ...via };
  return source.requestedBy === undefined
    ? { type: "system", process: source.process }
    : { type: "system", process: source.process, requestedBy: source.requestedBy };
}

/** `actorId` (kept for compatibility: the person or `null`) and `actor` for a payload. */
export function eventAttribution(source: PersonChangeSource): PersonAttribution;
export function eventAttribution(source: ChangeSource): Attribution;
export function eventAttribution(source: ChangeSource): Attribution {
  return { actorId: source.kind === "system" ? null : source.userId, actor: eventActor(source) };
}

/**
 * Domain event types written to `events_outbox`. These names are a public contract:
 * webhooks and future adapters subscribe to them, so never rename one.
 */
export const LEAVE_EVENT_TYPES = {
  requested: "leave.requested",
  approved: "leave.approved",
  rejected: "leave.rejected",
  cancelled: "leave.cancelled",
} as const;
export type LeaveEventType = (typeof LEAVE_EVENT_TYPES)[keyof typeof LEAVE_EVENT_TYPES];

/**
 * Version 1 payload of every `leave.*` event. Add fields; never remove or retype one.
 * The actor is the requester, the approver, or an admin.
 */
export interface LeaveEventPayload extends PersonAttribution {
  requestId: string;
  userId: string;
  leaveTypeId: string;
  startDate: CalendarDate;
  endDate: CalendarDate;
  dayPortion: DayPortion;
  days: number;
  status: LeaveStatus;
}

/** The leave request fields an event payload is built from. */
export interface LeaveEventSource {
  id: string;
  userId: string;
  leaveTypeId: string;
  startDate: CalendarDate;
  endDate: CalendarDate;
  dayPortion: DayPortion;
  days: number;
  status: LeaveStatus;
}

export function leaveEventPayload(request: LeaveEventSource, source: PersonChangeSource): LeaveEventPayload {
  return {
    requestId: request.id,
    userId: request.userId,
    leaveTypeId: request.leaveTypeId,
    startDate: request.startDate,
    endDate: request.endDate,
    dayPortion: request.dayPortion,
    days: request.days,
    status: request.status,
    ...eventAttribution(source),
  };
}

/** Audit log `action` for each leave transition, e.g. `leave_request.approved`. */
export function leaveAuditAction(event: "requested" | "reassigned" | "recounted" | LeaveStatus): string {
  return `leave_request.${event}`;
}

/** Balance event types written to `events_outbox`. Public contract; never rename one. */
export const BALANCE_EVENT_TYPES = {
  adjusted: "balance.adjusted",
} as const;

/**
 * Why an allowance row changed.
 *
 * - `carryover`: the year rollover set `carriedOverDays` from the previous year.
 * - `allowance_created`: a row was created from the leave type's default, or copied
 *   from the person's latest row for a type without a default.
 * - `admin_edit`: an admin set the year's `days` or `adjustmentDays` (never
 *   `carriedOverDays`, which the rollover owns). The admin's reason is in the audit
 *   row only.
 * - `sync`: an integration adapter's inbound sync set the year's `days` (and
 *   `adjustmentDays`, when it sent one). Same columns as `admin_edit`.
 */
/**
 * Why an allowance row changed. `allowance_rule`: the row was following its person's
 * default and an allowance rule (or the person's department or level) changed it.
 */
export type BalanceChangeReason = "carryover" | "allowance_created" | "admin_edit" | "sync" | "allowance_rule";

/**
 * Version 1 payload of `balance.adjusted`: the allowance row after the change. The year
 * rollover's changes have no person behind them (`actorId: null`, `actor` names the
 * process), unless an admin's or a sync's edit of last year re-carried them.
 */
export interface BalanceAdjustedPayload extends Attribution {
  allowanceId: string;
  userId: string;
  leaveTypeId: string;
  year: number;
  days: number;
  carriedOverDays: number;
  adjustmentDays: number;
  reason: BalanceChangeReason;
}

/** Audit log `action` for each allowance change. */
export const ALLOWANCE_AUDIT_ACTIONS: Readonly<Record<BalanceChangeReason, string>> = {
  carryover: "allowance.carried_over",
  allowance_created: "allowance.created",
  admin_edit: "allowance.edited",
  sync: "allowance.synced",
  allowance_rule: "allowance.rule_applied",
};

/** Calendar feed event types written to `events_outbox`. Public contract; never rename one. */
export const CALENDAR_FEED_EVENT_TYPES = {
  issued: "calendar_feed.issued",
  revoked: "calendar_feed.revoked",
} as const;
export type CalendarFeedEventType = (typeof CALENDAR_FEED_EVENT_TYPES)[keyof typeof CALENDAR_FEED_EVENT_TYPES];

/**
 * Why a feed link stopped working.
 *
 * - `regenerated`: its owner asked for a new link, which replaced it.
 * - `turned_off`: its owner turned the feed off.
 * - `deactivated`: an admin deactivated its owner; the admin is the actor.
 */
export type CalendarFeedRevokeReason = "regenerated" | "turned_off" | "deactivated";

/**
 * Version 1 payload of the `calendar_feed.*` events. Never carries the token or its
 * hash: the link is a secret, and the outbox is delivered to other systems.
 */
export interface CalendarFeedEventPayload extends PersonAttribution {
  feedId: string;
  userId: string;
  kind: FeedKind;
  /** Set on `calendar_feed.revoked` only. */
  reason: CalendarFeedRevokeReason | null;
}

/** Audit log `action` for each feed change: `calendar_feed.issued` or `calendar_feed.revoked`. */
export function calendarFeedAuditAction(event: keyof typeof CALENDAR_FEED_EVENT_TYPES): string {
  return CALENDAR_FEED_EVENT_TYPES[event];
}

/**
 * `leave.reassigned`: a pending request moved to another approver because an admin
 * changed who may decide it: its approver was deactivated or demoted from admin, the
 * requester's manager or department changed, their department's manager changed, or
 * someone was invited as admin, promoted to admin or
 * reactivated who can now take a request an admin had routed to themself. The actor is
 * always the admin who made that change. Public contract; never rename it.
 */
export const LEAVE_REASSIGNED_EVENT_TYPE = "leave.reassigned";

/**
 * `leave.recounted`: a pending or approved request's days changed (its total, or only how
 * they split between years, so `days` may equal `previousDays`), because an admin added
 * or deleted a company holiday on its dates or changed the company's working days. Only
 * the years still open are recounted. The actor is that admin, `via` `holiday_change` or
 * `working_days_change`. A request left with no working days is kept, at 0 days, and is
 * never cancelled by a recount. Public contract; never rename it.
 */
export const LEAVE_RECOUNTED_EVENT_TYPE = "leave.recounted";

/** Version 1 payload of `leave.recounted`: the leave fields (with the new `days`) plus the old count. */
export interface LeaveRecountedPayload extends LeaveEventPayload {
  previousDays: number;
}

/** Version 1 payload of `leave.reassigned`: the leave fields plus who it moved from and to. */
export interface LeaveReassignedPayload extends LeaveEventPayload {
  previousApproverId: string | null;
  /** The new approver, chosen by the approval rule; `null` when nobody qualifies. */
  approverId: string | null;
}

/**
 * Admin event types written to `events_outbox`. Public contract; never rename
 * one. Each is also the `audit_log.action` of the same change.
 */
export const ADMIN_EVENT_TYPES = {
  userCreated: "user.created",
  userUpdated: "user.updated",
  userDeactivated: "user.deactivated",
  userReactivated: "user.reactivated",
  userInviteResent: "user.invite_resent",
  userDeletionScheduled: "user.deletion_scheduled",
  userDeletionCancelled: "user.deletion_cancelled",
  userDeleted: "user.deleted",
  departmentCreated: "department.created",
  departmentRenamed: "department.renamed",
  departmentDeleted: "department.deleted",
  departmentManagerChanged: "department.manager_changed",
  levelCreated: "level.created",
  levelRenamed: "level.renamed",
  levelDeleted: "level.deleted",
  allowanceRuleSet: "allowance_rule.set",
  allowanceRuleRemoved: "allowance_rule.removed",
  leaveTypeCreated: "leave_type.created",
  leaveTypeUpdated: "leave_type.updated",
  leaveTypeArchived: "leave_type.archived",
  leaveTypeUnarchived: "leave_type.unarchived",
  leaveTypeReordered: "leave_type.reordered",
  holidayCreated: "holiday.created",
  holidayRenamed: "holiday.renamed",
  holidayDeleted: "holiday.deleted",
  companyUpdated: "company.updated",
  emailTemplateUpdated: "email_template.updated",
  emailTemplateReset: "email_template.reset",
} as const;
export type AdminEventType = (typeof ADMIN_EVENT_TYPES)[keyof typeof ADMIN_EVENT_TYPES];

/**
 * Version 1 payload of every `user.*` event: the person after the change. Never holds
 * a session, token or sign-in link.
 *
 * The actor is the admin who made the change. For an integration adapter's inbound
 * sync, the admin who pressed Sync now (`actor.via` names the sync), or, for a scheduled
 * sync, nobody (`actorId: null`, `actor` names the process).
 */
export interface UserEventPayload extends Attribution {
  userId: string;
  email: string;
  name: string;
  role: Role;
  departmentId: string | null;
  /** Their level (for allowance rules), added within version 1. */
  levelId: string | null;
  managerId: string | null;
  canSelfApprove: boolean;
  isActive: boolean;
}

/**
 * Audit `action` of an admin downloading a person's records (the CSV offered before a
 * delete). A read, not a state change, so it writes an audit row and no event.
 */
export const RECORDS_EXPORTED_AUDIT_ACTION = "user.records_exported";

/** How a person was deleted: nothing kept (`scrubbed`), or their history kept under a tombstone (`records_kept`). */
export type DeletionMode = "scrubbed" | "records_kept";

/**
 * Version 1 payload of `user.deleted`. No name or email: the person is gone, and the
 * outbox is delivered to other systems. Integrations should erase their own copy of the
 * person on `mode: "scrubbed"`.
 *
 * The actor is the admin who deleted them, or, for a full scrub that waited out the
 * company's grace period, the system (`actor.process` `scheduled_scrub`, with the admin
 * who asked in `actor.requestedBy`).
 */
export interface UserDeletedPayload extends Attribution {
  userId: string;
  mode: DeletionMode;
  /** When the delete ran, ISO 8601 in UTC. */
  deletedAt: string;
}

/**
 * Version 1 payload of `user.deletion_scheduled` and `user.deletion_cancelled`: a full
 * scrub waiting out the company's grace period, and an admin's undo of it. No name or email.
 */
export interface UserDeletionScheduleEventPayload extends PersonAttribution {
  userId: string;
  /** When the scrub may run (ISO 8601, UTC); on `cancelled`, when it would have. */
  scheduledFor: string;
}

/**
 * Version 1 payload of every `department.*` event: the department after the change
 * (before, when deleted). Made by a person, except `department.manager_changed` when a
 * scheduled scrub deletes the department's manager (`actorId` is then `null`).
 */
export interface DepartmentEventPayload extends Attribution {
  departmentId: string;
  name: string;
  /**
   * Added within version 1: the department's optional manager, who approves for its
   * people whose own manager is missing or inactive.
   */
  managerId: string | null;
}

/** Version 1 payload of every `level.*` event: the level after the change (before, when deleted). */
export interface LevelEventPayload extends PersonAttribution {
  levelId: string;
  name: string;
}

/**
 * Version 1 payload of `allowance_rule.set` and `.removed`: the rule after the change
 * (before, when removed). People's allowance rows it moves each get `balance.adjusted`
 * (`reason: "allowance_rule"`).
 */
export interface AllowanceRuleEventPayload extends PersonAttribution {
  ruleId: string;
  leaveTypeId: string;
  departmentId: string | null;
  levelId: string | null;
  days: number;
}

/** Version 1 payload of every `leave_type.*` event: the leave type after the change. */
export interface LeaveTypeEventPayload extends PersonAttribution {
  leaveTypeId: string;
  code: string;
  name: string;
  color: string;
  isPaid: boolean;
  countsAgainstAllowance: boolean;
  defaultAllowanceDays: number | null;
  carryoverEnabled: boolean;
  carryoverMaxDays: number | null;
  sortOrder: number;
  archived: boolean;
}

/** Version 1 payload of every `holiday.*` event: the holiday after the change (before, when deleted). */
export interface HolidayEventPayload extends PersonAttribution {
  holidayId: string;
  date: CalendarDate;
  name: string;
}

/**
 * Version 1 payload of `email_template.updated` and `.reset`: a company's own words for
 * one email after the change (both null after a reset). `notificationType` names the
 * email, such as `leave.requested` or `invite`; new ones may appear.
 */
export interface EmailTemplateEventPayload extends PersonAttribution {
  notificationType: string;
  subject: string | null;
  message: string | null;
}

/** Version 1 payload of `company.updated`: the settings after the change. */
export interface CompanyEventPayload extends PersonAttribution {
  companyId: string;
  name: string;
  timezone: string;
  workingDays: number[];
  allowancePolicy: string;
  /** Added within version 1: full-scrub deletes wait 7 days, with undo. */
  deletionGrace: boolean;
  /** Added within version 1: managers see their direct reports' balances and request notes. */
  managersSeeDetails: boolean;
  /**
   * Added within version 1: `required` (time off waits for an approver) or `heads_up`
   * (booked as it is sent; the person's active manager, else the fallback admin, is told,
   * and nobody when there is neither). New values may appear.
   */
  approvalMode: string;
  /** Added within version 1: what employees see of colleagues' time off: `everyone`, `team` or `self`. */
  colleagueVisibility: string;
  /** Added within version 1: the theme key everyone sees, e.g. `classic` or `cobalt`. */
  theme: string;
  /** Added within version 1: `#rrggbb` replacing the theme's accent, or null. */
  accentColor: string | null;
  /** Added within version 1: `theme`, `square`, `soft` or `round`. */
  corners: string;
  /** Added within version 1: how Home asks for time off, `form` or `sentence`. */
  requestStyle: string;
  /** Added within version 1: the layout trial, `standard`, `tonal`, `grouped`, `compact` or `legible`. */
  layout: string;
  /**
   * Added within version 1: the company's logo (its SHA-256, `image/png` or `image/jpeg`,
   * and its size in pixels), or null for none. The file is at `/logo/<sha256>.<png|jpg>`.
   */
  logo: { sha256: string; contentType: LogoType; width: number; height: number } | null;
}

/**
 * Integration event types written to `events_outbox`. Public contract; never
 * rename one. Each is also the `audit_log.action` of the same change, and the actor is
 * always the admin who made it.
 */
export const INTEGRATION_EVENT_TYPES = {
  webhookEndpointCreated: "webhook_endpoint.created",
  webhookEndpointUpdated: "webhook_endpoint.updated",
  webhookEndpointEnabled: "webhook_endpoint.enabled",
  webhookEndpointDisabled: "webhook_endpoint.disabled",
  webhookEndpointSecretRotated: "webhook_endpoint.secret_rotated",
  webhookEndpointDeleted: "webhook_endpoint.deleted",
  webhookEndpointPinged: "webhook_endpoint.pinged",
  webhookDeliveryRedelivered: "webhook_delivery.redelivered",
  apiKeyCreated: "api_key.created",
  apiKeyRevoked: "api_key.revoked",
} as const;
export type IntegrationEventType = (typeof INTEGRATION_EVENT_TYPES)[keyof typeof INTEGRATION_EVENT_TYPES];

/**
 * Version 1 payload of every `webhook_endpoint.*` event: the endpoint after the change
 * (before, when deleted). Carries only the URL's origin (`https://example.com`), never
 * its path or query, which often hold a token (Slack, Zapier), and never the signing
 * secret.
 */
export interface WebhookEndpointEventPayload extends PersonAttribution {
  endpointId: string;
  urlOrigin: string;
  description: string;
  eventTypes: string[];
  enabled: boolean;
  /**
   * `webhook_endpoint.updated` only: whether the full URL changed, so a move to another
   * path on the same origin is visible. Never the URL itself.
   */
  urlChanged?: boolean;
}

/** Version 1 payload of `webhook_delivery.redelivered`: the delivery an admin queued again. */
export interface WebhookRedeliveredPayload extends PersonAttribution {
  endpointId: string;
  deliveryId: string;
  eventId: string;
  eventType: string;
}

/**
 * Import event types written to `events_outbox`. Public contract; never rename one.
 *
 * An import writes one `import.completed` event, and only that: it does not replay the
 * imported history (thousands of `leave.*`, `user.created` and `balance.adjusted` events
 * about the past) to webhooks and adapters. Every imported row still has its own audit
 * row (`import.*` actions, {@link IMPORT_AUDIT_ACTIONS}), so the trail is complete
 * inside OOOhm; a system that mirrors OOOhm resyncs through the REST API when it
 * receives this event.
 */
export const IMPORT_EVENT_TYPES = {
  completed: "import.completed",
} as const;

/**
 * Version 1 payload of `import.completed`. Counts and the source file's hash only: no
 * names, emails or notes, since the outbox is delivered to other systems.
 *
 * An import is started by a person, so the actor is the admin who ran it (`--actor`),
 * through the import: `actor` is `{ type: "user", id, via: "timeoff_import" }`.
 */
export interface ImportCompletedPayload extends PersonAttribution {
  importRunId: string;
  /** Which importer ran, e.g. `timeoff`. */
  source: string;
  /** SHA-256 (hex) of the imported file. */
  sourceSha256: string;
  counts: {
    people: number;
    departments: number;
    leaveTypes: number;
    holidays: number;
    allowances: number;
    leaveRequests: number;
  };
  /** Person-years whose balance differs from the source's (only non-zero with `--accept-mismatch`). */
  mismatches: number;
}

/**
 * Audit `action` for each kind of imported row. Imported rows are audited one by one in
 * the import's transaction, under these actions rather than the live ones
 * (`user.created`, `leave_request.approved`), so the audit viewer can tell history
 * brought in from another system from changes made in OOOhm. Each row is attributed to
 * the admin who ran the import, via `timeoff_import`, and its `after` holds
 * `source: "import:timeoff"` and the source record's id.
 */
export const IMPORT_AUDIT_ACTIONS = {
  company: "import.company",
  department: "import.department",
  leaveType: "import.leave_type",
  holiday: "import.holiday",
  user: "import.user",
  allowance: "import.allowance",
  leaveRequest: "import.leave_request",
  completed: "import.completed",
} as const;

/** Version 1 payload of every `api_key.*` event. Never the key or its hash; `prefix` is the part shown to admins. */
export interface ApiKeyEventPayload extends PersonAttribution {
  apiKeyId: string;
  name: string;
  prefix: string;
  scopes: string[];
}
