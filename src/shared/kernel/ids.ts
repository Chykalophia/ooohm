import { isUuid } from "@/domain/ids";

/**
 * Branded ids (shared kernel): a `UserId` cannot be passed where a `CompanyId` is
 * expected, though both are UUID strings at runtime. Parse at the edges (route params,
 * forms, the session), then pass the branded type inward.
 */
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type CompanyId = Brand<string, "CompanyId">;
export type UserId = Brand<string, "UserId">;
export type LeaveRequestId = Brand<string, "LeaveRequestId">;
export type LeaveTypeId = Brand<string, "LeaveTypeId">;
export type DepartmentId = Brand<string, "DepartmentId">;

function parser<T extends string>() {
  return (value: unknown): T | null => (isUuid(value) ? (value.toLowerCase() as T) : null);
}

/** The id, or `null` when it is not a UUID. */
export const parseCompanyId = parser<CompanyId>();
export const parseUserId = parser<UserId>();
export const parseLeaveRequestId = parser<LeaveRequestId>();
export const parseLeaveTypeId = parser<LeaveTypeId>();
export const parseDepartmentId = parser<DepartmentId>();
