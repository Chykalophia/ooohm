import "server-only";
import type { PageCursor } from "@/shared/kernel/paging";

/** Rows per page the viewer offers; the first is the default. */
export const AUDIT_PAGE_SIZES = [25, 50, 100] as const;
export type AuditPageSize = (typeof AUDIT_PAGE_SIZES)[number];
/** Rows per page unless the viewer asks for another of {@link AUDIT_PAGE_SIZES}. */
export const AUDIT_PAGE_SIZE: AuditPageSize = AUDIT_PAGE_SIZES[0];

/** The longest search the viewer takes; anything longer is cut. */
export const AUDIT_SEARCH_MAX_LENGTH = 100;

/** What the viewer filters on. Anything malformed is ignored rather than refused. */
export interface AuditLogFilter {
  action?: string;
  actorId?: string;
  subjectUserId?: string;
  /** First day, `YYYY-MM-DD`, in the company's time zone. */
  from?: string;
  /** Last day, `YYYY-MM-DD`, in the company's time zone. */
  to?: string;
  /**
   * Words to look for in the change's name ("declined"), who made it or who it is about
   * (name or email); every word must match. Matched in the app against those labels,
   * then read with the ids, so the database never scans text.
   */
  query?: string;
  /** Oldest first instead of newest first. A cursor belongs to one order: switching starts at page 1. */
  oldestFirst?: boolean;
  /** Rows per page, one of {@link AUDIT_PAGE_SIZES}; anything else is the default. */
  size?: number;
  /** The page, from a previous page's `previous` or `next`; the first page when absent. */
  page?: PageCursor;
}
