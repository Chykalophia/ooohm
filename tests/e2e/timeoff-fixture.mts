/**
 * Writes the synthetic TimeOff.Management database the tests use to a file, for trying
 * `pnpm import:timeoff` end to end against a real build (docs/import.md, "Try it").
 *
 *   tsx --conditions=react-server --no-warnings=ExperimentalWarning tests/e2e/timeoff-fixture.mts /tmp/timeoff.sqlite
 *
 * The importer reconciles against today's year, so after 2026 the file also gets the
 * carry-over rows TimeOff would have written for each year since (see
 * `buildTimeOffFixtureThrough`); otherwise every current-year balance would mismatch.
 */
import { existsSync } from "node:fs";
import { yearInTimeZone } from "../../src/lib/dates";
import { buildTimeOffFixtureThrough, FIXTURE_LAST_YEAR } from "../support/timeoff-carry-forward";

const out = process.argv[2];
if (!out) {
  console.error("Usage: tsx tests/e2e/timeoff-fixture.mts <out.sqlite>");
  process.exit(2);
}
if (existsSync(out)) {
  console.error(`${out} already exists; choose a new path.`);
  process.exit(1);
}
// The fixture company's time zone, which is the year the importer reconciles.
const year = yearInTimeZone("America/Chicago");
buildTimeOffFixtureThrough(out, year);
const carried = year > FIXTURE_LAST_YEAR ? ` with TimeOff's carry-over through ${year}` : "";
console.log(`Wrote ${out}: one TimeOff company, 13 people, 22 leaves over 2025 and 2026${carried}.`);
