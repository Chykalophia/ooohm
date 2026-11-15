import "server-only";
import type { Executor } from "@/db/types";
import { listCompanies as read } from "@/shared/lib/db/pre-tenant";

/**
 * Every company with what a job that loops over them plans with, oldest first. A
 * pre-tenant read (ADR-0004): it runs on any executor, bound to a company or not; the
 * job then works on each company through `forTenant`.
 */
export function listCompanies(ex: Executor) {
  return read(ex);
}
