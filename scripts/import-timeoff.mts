/**
 * One-time import from TimeOff.Management's SQLite file:
 *
 *   pnpm import:timeoff -- --file <path.sqlite> (--company <id> | --create-company <name>) --actor <email>
 *                          [--apply] [--report <out.json>] [--timeoff-company <id>]
 *                          [--pool-type <name>] [--merge-pool-types] [--force] [--accept-mismatch]
 *
 * A dry run by default: everything is imported and reconciled inside a transaction that
 * is then rolled back, and the full report is printed. `--apply` commits, in the same
 * single transaction, only when every current-year balance matches TimeOff's. See
 * docs/import.md for the mapping and the runbook. Needs only the database settings.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { resolveDatabaseConfig } from "../src/db/config";
import { openDatabase } from "../src/db/connect";
import { isDomainError } from "../src/domain/errors";
import { nonEmptyEnv } from "../src/lib/integration-env";
import { readTimeOffSqlite } from "../src/server/importers/timeoff/sqlite-reader";
import { importTimeOff, type TimeOffImportReport } from "../src/server/services/timeoff-import";
import { scriptContext } from "./script-context.mts";

const USAGE = `Usage: pnpm import:timeoff -- --file <timeoff.sqlite> (--company <id> | --create-company <name>) --actor <email> [options]

  --file <path>            TimeOff.Management's SQLite database (opened read-only)
  --company <id>           import into this existing OOOhm company (usually the seeded one)
  --create-company <name>  or create the company for it (only when the database has no company yet)
  --actor <email>          you: an active admin of that company (with --create-company, one of
                           TimeOff's admins). Every change is recorded as yours, via the import
  --apply                  commit (default: dry run, nothing is written)
  --report <out.json>      also write the full report as JSON
  --timeoff-company <id>   which TimeOff company, when the file holds several
  --pool-type <name>       the TimeOff leave type whose name the allowance type takes
  --merge-pool-types       merge every TimeOff type that uses the allowance into that one type
  --force                  import into a company that already has requests or non-admin members
                           (adds all TimeOff leave; a company with a TimeOff import is always refused)
  --accept-mismatch        commit even when a current-year balance differs from TimeOff's`;

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
let options;
try {
  options = parseArgs({
    args,
    options: {
      file: { type: "string" },
      company: { type: "string" },
      "create-company": { type: "string" },
      actor: { type: "string" },
      apply: { type: "boolean", default: false },
      report: { type: "string" },
      "timeoff-company": { type: "string" },
      "pool-type": { type: "string" },
      "merge-pool-types": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      "accept-mismatch": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  }).values;
} catch (err) {
  fail(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
}
if (options.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!options.file) fail(`--file is required.\n\n${USAGE}`);
if (Boolean(options.company) === Boolean(options["create-company"])) fail(`Pass exactly one of --company or --create-company.\n\n${USAGE}`);
if (!options.actor) fail(`--actor is required: the email of the admin running the import.\n\n${USAGE}`);
const timeoffCompany = options["timeoff-company"];
if (timeoffCompany !== undefined && !/^\d+$/.test(timeoffCompany)) fail("--timeoff-company takes TimeOff's numeric company id.");

let config;
try {
  config = resolveDatabaseConfig(nonEmptyEnv(process.env));
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

let bytes: Buffer;
try {
  bytes = readFileSync(options.file);
} catch (err) {
  fail(`Cannot read ${options.file}: ${err instanceof Error ? err.message : String(err)}`, 1);
}
const source = { sha256: createHash("sha256").update(bytes).digest("hex"), fileName: basename(options.file) };

const handle = await openDatabase(config, { purpose: "pnpm import:timeoff", max: 2 });
const ctx = scriptContext(handle.db, "importer");

function pad(value: string, width: number, right = false): string {
  return right ? value.padStart(width) : value.padEnd(width);
}

function print(report: TimeOffImportReport): void {
  const c = report.counts;
  const mode = { dry_run: "DRY RUN: nothing was written", applied: "APPLIED", rolled_back: "NOT APPLIED: rolled back" }[report.outcome];
  console.log(`\n${mode}`);
  console.log(`Source:  ${report.source.fileName} (sha256 ${report.source.sha256})`);
  console.log(`Run by:  ${report.actor.email} (${report.actor.userId}), via the TimeOff import`);
  console.log(`Company: ${report.company.name} (${report.company.id})${report.company.created ? ", created" : ""}, ${report.company.timezone}, working days ${report.company.workingDays.join(",")}`);
  if (report.poolLeaveType) {
    console.log(`Allowance pool: "${report.poolLeaveType.name}" (${report.poolLeaveType.code}), from TimeOff ${report.poolLeaveType.mergedFrom.map((n) => `"${n}"`).join(", ")}`);
  }
  console.log(
    `People ${c.people.created} new + ${c.people.updated} existing (${c.people.active} active, ${c.people.inactive} inactive); ` +
      `departments ${c.departments.created} new; leave types ${c.leaveTypes.created} new, ${c.leaveTypes.updated} matched, ${c.leaveTypes.archived} archived; ` +
      `holidays ${c.holidays.created}; allowances ${c.allowances}; requests ${c.leaveRequests.total} ` +
      `(${c.leaveRequests.approved} approved, ${c.leaveRequests.pending} pending, ${c.leaveRequests.rejected} declined, ${c.leaveRequests.cancelled} cancelled); ` +
      `skipped ${c.skipped.users} people, ${c.skipped.leaves} leaves.`,
  );

  const rows = report.reconciliation.rows;
  const width = Math.max(5, ...rows.map((r) => r.email.length));
  console.log(`\nBalance reconciliation (days left before pending; current year ${report.reconciliation.currentYear})`);
  console.log(`${pad("Email", width)}  Year  ${pad("TimeOff", 8, true)}  ${pad("OOOhm", 8, true)}  ${pad("Diff", 6, true)}`);
  for (const r of rows) {
    const diff = r.diff === null ? "n/a" : r.diff === 0 ? "0" : r.diff > 0 ? `+${r.diff}` : String(r.diff);
    console.log(`${pad(r.email, width)}  ${r.year}  ${pad(String(r.timeoff), 8, true)}  ${pad(r.ooohm === null ? "-" : String(r.ooohm), 8, true)}  ${pad(diff, 6, true)}${r.diff === 0 ? "" : "  <-"}`);
  }
  const mm = report.reconciliation.mismatches;
  console.log(`\n${mm.length === 0 ? "Every balance matches." : `${mm.length} mismatch(es), ${report.reconciliation.currentYearMismatches} in the current year:`}`);
  for (const m of mm) console.log(`  ${m.email} ${m.year}: TimeOff ${m.timeoff}, OOOhm ${m.ooohm ?? "-"}\n    - ${m.reasons.join("\n    - ")}`);

  if (report.conflicts.length > 0) {
    console.log(`\nConflicts (${report.conflicts.length}):`);
    for (const i of report.conflicts) console.log(`  - ${i.message}`);
  }
  if (report.warnings.length > 0) {
    console.log(`\nWarnings (${report.warnings.length}):`);
    for (const i of report.warnings) console.log(`  - ${i.message}`);
  }
  if (report.outcome === "dry_run") {
    console.log(
      report.reconciliation.currentYearMismatches > 0
        ? "\nAn --apply run would be refused until the current-year mismatches are resolved (or --accept-mismatch is passed)."
        : "\nRe-run with --apply to commit exactly this.",
    );
  } else if (report.outcome === "rolled_back") {
    console.log("\nCurrent-year balances differ, so nothing was committed. Resolve them, or pass --accept-mismatch.");
  } else {
    console.log(`\nImport run ${report.importRunId} committed. Imported people sign in with a magic link from the sign-in page.`);
  }
}

let exitCode = 0;
try {
  const snapshot = readTimeOffSqlite(options.file);
  const report = await importTimeOff(ctx, {
    snapshot,
    source,
    target: options.company ? { companyId: options.company } : { createCompany: options["create-company"]! },
    actorEmail: options.actor,
    timeoffCompanyId: timeoffCompany === undefined ? undefined : Number(timeoffCompany),
    poolType: options["pool-type"],
    mergePoolTypes: options["merge-pool-types"],
    apply: options.apply,
    force: options.force,
    acceptMismatch: options["accept-mismatch"],
  });
  print(report);
  if (options.report) {
    // The report names people and their balances: readable by the owner only.
    writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(`Report written to ${options.report}.`);
  }
  if (report.outcome === "rolled_back") exitCode = 1;
} catch (err) {
  exitCode = 1;
  if (isDomainError(err)) {
    console.error(`Refused: ${err.message}`);
  } else {
    console.error(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
  }
} finally {
  await handle.close();
}
process.exitCode = exitCode;
