import type { CalendarDate } from "./calendar-date";
import type { FeedKind } from "./calendar-feed";
import type { DayPortion, LeaveStatus } from "./leave-request";

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

/** Version 1 payload of every `leave.*` event. Add fields; never remove or retype one. */
export interface LeaveEventPayload {
  requestId: string;
  userId: string;
  leaveTypeId: string;
  startDate: CalendarDate;
  endDate: CalendarDate;
  dayPortion: DayPortion;
  days: number;
  status: LeaveStatus;
  /** Who caused the change: the requester, the approver, or an admin. */
  actorId: string;
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

export function leaveEventPayload(request: LeaveEventSource, actorId: string): LeaveEventPayload {
  return {
    requestId: request.id,
    userId: request.userId,
    leaveTypeId: request.leaveTypeId,
    startDate: request.startDate,
    endDate: request.endDate,
    dayPortion: request.dayPortion,
    days: request.days,
    status: request.status,
    actorId,
  };
}

/** Audit log `action` for each leave transition, e.g. `leave_request.approved`. */
export function leaveAuditAction(event: "requested" | LeaveStatus): string {
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
 */
export type BalanceChangeReason = "carryover" | "allowance_created";

/** Version 1 payload of `balance.adjusted`: the allowance row after the change. */
export interface BalanceAdjustedPayload {
  allowanceId: string;
  userId: string;
  leaveTypeId: string;
  year: number;
  days: number;
  carriedOverDays: number;
  adjustmentDays: number;
  reason: BalanceChangeReason;
  /** Who made the change; `null` for a system job such as the year rollover. */
  actorId: string | null;
}

/** Audit log `action` for each allowance change. */
export const ALLOWANCE_AUDIT_ACTIONS: Readonly<Record<BalanceChangeReason, string>> = {
  carryover: "allowance.carried_over",
  allowance_created: "allowance.created",
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
 */
export type CalendarFeedRevokeReason = "regenerated" | "turned_off";

/**
 * Version 1 payload of the `calendar_feed.*` events. Never carries the token or its
 * hash: the link is a secret, and the outbox is delivered to other systems.
 */
export interface CalendarFeedEventPayload {
  feedId: string;
  userId: string;
  kind: FeedKind;
  /** Set on `calendar_feed.revoked` only. */
  reason: CalendarFeedRevokeReason | null;
  actorId: string;
}

/** Audit log `action` for each feed change: `calendar_feed.issued` or `calendar_feed.revoked`. */
export function calendarFeedAuditAction(event: keyof typeof CALENDAR_FEED_EVENT_TYPES): string {
  return CALENDAR_FEED_EVENT_TYPES[event];
}
