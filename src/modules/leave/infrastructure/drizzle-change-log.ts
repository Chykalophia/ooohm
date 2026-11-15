import "server-only";
import type { Transaction } from "@/db/types";
import { recordChange } from "@/shared/lib/db/change-log";
import type { ChangeLog } from "../application/ports";

/** Audit row and outbox event in `tx`, through `recordChange` (ADR-0010). */
export function drizzleChangeLog(tx: Transaction): ChangeLog {
  return { record: (change) => recordChange(tx, change) };
}
