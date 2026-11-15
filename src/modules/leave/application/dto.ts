import "server-only";
import type { ApprovalMode } from "@/shared/kernel/approval";
import type { CalendarDate } from "@/domain/calendar-date";
import type { PageCursor } from "@/domain/paging";
import type { BalanceSummary } from "@/modules/balances";
import type { DayPortion, LeaveStatus } from "@/shared/kernel/leave-range";
import type { LeaveRequest } from "../domain/leave-request";
import type { OwnRequest } from "./ports";

/** A leave request as the module hands it out. */
export interface LeaveRequestDTO {
  id: string;
  companyId: string;
  userId: string;
  leaveTypeId: string;
  startDate: CalendarDate;
  endDate: CalendarDate;
  dayPortion: DayPortion;
  days: number;
  note: string | null;
  status: LeaveStatus;
  approverId: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toLeaveRequestDTO(r: LeaveRequest): LeaveRequestDTO {
  return {
    id: r.id,
    companyId: r.companyId,
    userId: r.userId,
    leaveTypeId: r.leaveTypeId,
    startDate: r.startDate,
    endDate: r.endDate,
    dayPortion: r.dayPortion,
    days: r.days,
    note: r.note,
    status: r.status,
    approverId: r.approverId,
    decidedAt: r.decidedAt,
    decisionNote: r.decisionNote,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** A submitted request in its final state, with `headsUp`: booked because approval is turned off, not approved by anyone. */
export type SubmittedLeaveDTO = LeaveRequestDTO & { headsUp: boolean };

/** Time off added for someone, with how a confirmation names them. */
export type AddedLeaveDTO = LeaveRequestDTO & { personName: string };

/** One of a person's own requests, with whether they can cancel it today. */
export type OwnRequestDTO = OwnRequest & { cancellable: boolean };

/** A page of "Your requests". */
export interface MyRequestsPageDTO {
  items: OwnRequestDTO[];
  previous: PageCursor | null;
  next: PageCursor | null;
}

/** One of a person's own requests in full, with the company's time zone to show its times in. */
export interface MyRequestDTO {
  request: OwnRequestDTO;
  timezone: string;
}

/** A request on the dashboard: {@link OwnRequestDTO} plus how long its approver usually takes. */
export type DashboardRequestDTO = OwnRequestDTO & {
  /**
   * For a pending request with someone else: how long its approver usually takes, in
   * hours (their median over 180 days), or `null` with too little history to say.
   */
  typicalWaitHours: number | null;
};

/** Everything the dashboard renders for a person. */
export interface DashboardDTO {
  /** The person's latest few requests (latest dates first). */
  requests: DashboardRequestDTO[];
  /** `required` or `heads_up` (approval turned off): how the request form words itself. */
  approvalMode: ApprovalMode;
  /** Whether the person has more requests than the dashboard shows. */
  moreRequests: boolean;
  /** The form's default start date: the first working day from today (company time zone). */
  defaultDate: CalendarDate;
  /** Active leave types in display order; the first is the form's default. */
  leaveTypes: { id: string; name: string; code: string; color: string }[];
  /** The person's balances without types they have no days of at all; `null` when the allowance policy is unknown. */
  balances: BalanceSummary | null;
  /** From November 1: days of the main leave type that will not carry into next year. */
  expiring: { leaveTypeId: string; name: string; days: number }[];
}
