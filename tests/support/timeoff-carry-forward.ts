/**
 * Brings the synthetic TimeOff fixture up to a later year, as a TimeOff install that
 * kept running would be: for each year after 2026 up to `throughYear`, every person
 * still employed gets the `user_allowance_adjustment` row TimeOff's carry-over writes,
 * `carried_over_allowance` = min(last year's remaining, the company's `carry_over`).
 *
 * The default fixture stops at 2026. Imported later than that without these rows, its
 * current-year carried-over days would be 0 while OOOhm's year rollover computes the
 * real carry, and every balance would mismatch. That is right for a real export taken
 * before TimeOff's carry-over ran, but not what "try it locally" should show.
 *
 * Last year's remaining comes from the importer's own TimeOff balance module
 * (`buildImportPlan`'s expected balances), so the rows agree with what the import
 * reconciles against.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildImportPlan } from "@/domain/timeoff/mapping";
import { readTimeOffSqlite } from "@/server/importers/timeoff/sqlite-reader";
import { buildTimeOffFixture, type FixtureData } from "./timeoff-fixture";

/** The last year the default fixture has data for. */
export const FIXTURE_LAST_YEAR = 2026;

/**
 * Writes the fixture to `file` with TimeOff's carry-over applied for every year from
 * 2027 to `throughYear` (nothing extra when `throughYear` ≤ 2026).
 *
 * @returns The data as written.
 */
export function buildTimeOffFixtureThrough(file: string, throughYear: number, mutate?: (data: FixtureData) => void): FixtureData {
  const added: Record<string, unknown>[] = [];
  const withCarry = (d: FixtureData) => {
    mutate?.(d);
    d.adjustments.push(...added);
  };
  if (throughYear > FIXTURE_LAST_YEAR) {
    const scratch = mkdtempSync(path.join(tmpdir(), "ooohm-timeoff-carry-"));
    try {
      for (let year = FIXTURE_LAST_YEAR + 1; year <= throughYear; year++) {
        const step = path.join(scratch, `${year}.sqlite`);
        const data = buildTimeOffFixture(step, withCarry);
        const snapshot = readTimeOffSqlite(step);
        const company = snapshot.companies[0];
        const plan = buildImportPlan(snapshot, { mergePoolTypes: true, currentYear: year, today: `${year}-01-01` });
        const has = new Set(data.adjustments.map((a) => `${a.user_id}|${a.year}`));
        for (const person of plan.people.filter((p) => p.isActive)) {
          if (has.has(`${person.key}|${year}`)) continue;
          const closing = plan.expected.find((e) => e.personKey === person.key && e.year === year - 1)?.timeoff.remaining ?? 0;
          added.push({
            year,
            adjustment: 0,
            carried_over_allowance: Math.min(Math.max(closing, 0), company.carryOver),
            created_at: `${year}-01-01 00:00:00.000 +00:00`,
            user_id: person.key,
          });
        }
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  return buildTimeOffFixture(file, withCarry);
}
