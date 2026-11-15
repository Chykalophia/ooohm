import "server-only";
import type { Transaction } from "@/db/types";
import { recordAdminChange } from "@/shared/lib/admin-access";
import { recordChange } from "@/shared/lib/db/change-log";
import type { ChangeLog } from "../application/ports";

/** Balances' {@link ChangeLog}: `recordChange` and `recordAdminChange` inside `tx`. */
export function drizzleChangeLog(tx: Transaction): ChangeLog {
  return {
    record: (change) => recordChange(tx, change),
    recordAdmin: (actor, change) => recordAdminChange(tx, actor, change),
  };
}
