/**
 * Whether a query failed on a unique constraint (Postgres `23505`), optionally a named
 * one. Services check for a duplicate before inserting, so this only catches the race
 * where two writers pass that check at once; they map it to `already_exists`.
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    const pg = e as Error & { code?: unknown; constraint_name?: unknown };
    if (pg.code === "23505") return constraint === undefined || pg.constraint_name === constraint;
  }
  return false;
}
