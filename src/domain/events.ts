import type { CalendarDate } from "./calendar-date";
import type { FeedKind } from "./calendar-feed";
import type { Role } from "./actor";
import type { ChangeProcess, ChangeSource, PersonChangeSource } from "./change-source";
import type { DayPortion, LeaveStatus } from "./leave-request";

/**
 * Who or what made a change, as every event payload publishes it in `actor` (added
 * within version 1). `id` is the person: the one who acted, or who created the API key.
 * `via` and `process` are stable identifiers (`year_rollover`, `adapter_sync:<id>`).
 */
export type EventActor =
  | { type: "user"; id: string; via?: ChangeProcess }
  | { type: "api_key"; id: string; apiKeyId: string; via?: ChangeProcess }
  | { type: "system"; process: ChangeProcess };

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
  return { type: "system", process: source.process };
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
export function leaveAuditAction(event: "requested" | "reassigned" | LeaveStatus): string {
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
export type BalanceChangeReason = "carryover" | "allowance_created" | "admin_edit" | "sync";

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
 * requester's manager changed, or someone was invited as admin, promoted to admin or
 * reactivated who can now take a request an admin had routed to themself. The actor is
 * always the admin who made that change. Public contract; never rename it.
 */
export const LEAVE_REASSIGNED_EVENT_TYPE = "leave.reassigned";

/** Version 1 payload of `leave.reassigned`: the leave fields plus who it moved from and to. */
export interface LeaveReassignedPayload extends LeaveEventPayload {
  previousApproverId: string | null;
  /** The new approver, chosen by the approval rule; `null` when nobody qualifies. */
  approverId: string | null;
}

/**
 * Admin event types written to `events_outbox` (M5). Public contract; never rename
 * one. Each is also the `audit_log.action` of the same change.
 */
export const ADMIN_EVENT_TYPES = {
  userCreated: "user.created",
  userUpdated: "user.updated",
  userDeactivated: "user.deactivated",
  userReactivated: "user.reactivated",
  userInviteResent: "user.invite_resent",
  departmentCreated: "department.created",
  departmentRenamed: "department.renamed",
  departmentDeleted: "department.deleted",
  leaveTypeCreated: "leave_type.created",
  leaveTypeUpdated: "leave_type.updated",
  leaveTypeArchived: "leave_type.archived",
  leaveTypeUnarchived: "leave_type.unarchived",
  leaveTypeReordered: "leave_type.reordered",
  holidayCreated: "holiday.created",
  holidayRenamed: "holiday.renamed",
  holidayDeleted: "holiday.deleted",
  companyUpdated: "company.updated",
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
  managerId: string | null;
  canSelfApprove: boolean;
  isActive: boolean;
}

/** Version 1 payload of every `department.*` event: the department after the change (before, when deleted). */
export interface DepartmentEventPayload extends PersonAttribution {
  departmentId: string;
  name: string;
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

/** Version 1 payload of `company.updated`: the settings after the change. */
export interface CompanyEventPayload extends PersonAttribution {
  companyId: string;
  name: string;
  timezone: string;
  workingDays: number[];
  allowancePolicy: string;
}

/**
 * Integration event types written to `events_outbox` (M6). Public contract; never
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

/** Version 1 payload of every `api_key.*` event. Never the key or its hash; `prefix` is the part shown to admins. */
export interface ApiKeyEventPayload extends PersonAttribution {
  apiKeyId: string;
  name: string;
  prefix: string;
  scopes: string[];
}
