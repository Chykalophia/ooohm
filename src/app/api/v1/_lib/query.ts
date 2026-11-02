import { z } from "zod";
import { isCalendarDate } from "@/domain/calendar-date";
import { LEAVE_STATUSES } from "@/domain/leave-request";
import { API_DEFAULT_PAGE_SIZE, API_MAX_PAGE_SIZE } from "@/server/services/api-v1";

/** Query parameter schemas of `/api/v1`. The OpenAPI document describes the same rules. */

const limit = z.coerce.number().int().min(1).max(API_MAX_PAGE_SIZE).default(API_DEFAULT_PAGE_SIZE);
const cursor = z.string().min(1).max(500).optional();
const date = z.string().refine((v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && isCalendarDate(v));
const year = z.coerce.number().int().min(2000).max(2100).optional();
const id = z.string().min(1).max(100).optional();

export const usersQuery = z.object({ cursor, limit });

export const leaveRequestsQuery = z.object({
  from: date.optional(),
  to: date.optional(),
  userId: id,
  status: z.enum(LEAVE_STATUSES).optional(),
  cursor,
  limit,
});

export const balancesQuery = z.object({ year, userId: id });

export const holidaysQuery = z.object({ year });

export const eventsQuery = z.object({ after: id, limit });
