import "server-only";
import type { TimeOffSnapshot } from "@/modules/import/domain/timeoff/source";
import { readTimeOffSqlite } from "@/modules/import/infrastructure/timeoff-sqlite-reader";

/**
 * Reads a TimeOff.Management SQLite file into a snapshot for `importTimeOff`. Reads
 * the file only.
 *
 * @throws DomainError `import_refused` when the file is not a TimeOff database.
 */
export function readTimeOffFile(path: string): TimeOffSnapshot {
  return readTimeOffSqlite(path);
}
