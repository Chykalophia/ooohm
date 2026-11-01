import type { CalendarDate } from "./calendar-date";
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
