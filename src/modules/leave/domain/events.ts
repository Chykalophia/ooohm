import type { LeaveDomainEvent } from "./leave-request";

export type { LeaveDomainEvent };

/** Each domain event's transition, as `LEAVE_EVENT_TYPES` (src/shared/kernel/events.ts) names it. */
export const LEAVE_EVENT_NAMES = {
  LeaveRequested: "requested",
  LeaveApproved: "approved",
  LeaveCancelled: "cancelled",
} as const satisfies Record<LeaveDomainEvent["type"], string>;
