/**
 * Classifying database errors, whichever driver raised them: postgres.js names the
 * constraint `constraint_name`, PGlite (embedded mode) `constraint`, and drizzle wraps
 * either in a query error whose `cause` is the driver's.
 */

type DriverError = Error & { code?: unknown; constraint_name?: unknown; constraint?: unknown };

/** The driver's error inside `err` that carries a Postgres error code, if any. */
function driverError(err: unknown): DriverError | undefined {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if (typeof (e as DriverError).code === "string" && /^[0-9A-Z]{5}$/.test((e as DriverError).code as string)) return e as DriverError;
  }
  return undefined;
}

/** The constraint a query violated (unique, check, foreign key), when the error names one. */
export function violatedConstraint(err: unknown): string | undefined {
  const e = driverError(err);
  const name = e?.constraint_name ?? e?.constraint;
  return typeof name === "string" ? name : undefined;
}

/**
 * Whether a query failed on a unique constraint (Postgres `23505`), optionally a named
 * one. Services check for a duplicate before inserting, so this only catches the race
 * where two writers pass that check at once; they map it to `already_exists`.
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = driverError(err);
  if (e?.code !== "23505") return false;
  return constraint === undefined || violatedConstraint(e) === constraint;
}
