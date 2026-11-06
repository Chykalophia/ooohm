# Importing from TimeOff.Management

OOOhm replaces TimeOff.Management. `pnpm import:timeoff` reads TimeOff's SQLite database once and brings in its
people, departments, leave types, bank holidays, allowances and the whole leave history. Every balance is then
checked against TimeOff's own figure, and the import commits only when every current-year balance matches
(earlier years are reported; `--accept-mismatch` overrides).

The importer was written from TimeOff's data layout (its tables and columns) and its documented balance rules.
It uses none of TimeOff's code.

## The short version

```bash
# 1. Dry run (the default): imports everything inside a transaction, reconciles, rolls back, prints the report.
pnpm import:timeoff -- --file timeoff.sqlite --company <company id> --actor <your email> --merge-pool-types --report dry-run.json

# 2. Read the reconciliation table and the warnings. Every row should say Diff 0.

# 3. Commit exactly that.
pnpm import:timeoff -- --file timeoff.sqlite --company <company id> --actor <your email> --merge-pool-types --apply
```

On the production server the commands run in the `migrate` container; see [deploy.md](deploy.md#11-import-from-timeoffmanagement).

## Options

| Option | |
| --- | --- |
| `--file <path>` | TimeOff's SQLite file. Opened read-only; the importer never changes it. |
| `--company <id>` | Import into this OOOhm company, normally the one the first start seeded. The error message lists the ids when the one given does not exist. |
| `--create-company <name>` | Or create a new company for it, with TimeOff's time zone and working days. Only on an empty database: OOOhm runs one company per deployment, so once any company exists (the first start seeds one) this is refused, and the message names the company to pass to `--company` instead. |
| `--actor <email>` | Required. You: the admin running the import. Every row it writes is recorded as your change, via the import (see [Audit and events](#audit-and-events)). Checked after people are imported, so it must be an active admin of the target company as the import leaves it: an existing admin, or, with `--create-company`, one of TimeOff's admins. Anyone else is refused and nothing is written, dry run or not. |
| `--apply` | Commit. Without it nothing is written (dry run). |
| `--report <out.json>` | Also write the full report as JSON (mode 600: it names people and their balances). |
| `--timeoff-company <id>` | Which TimeOff company, when the file holds more than one. |
| `--merge-pool-types` | Needed when several TimeOff leave types use the allowance (see below). |
| `--pool-type <name>` | Which of those TimeOff types names the merged OOOhm type. Default: the first by TimeOff's sort order. |
| `--force` | Import into a company that already has leave requests, or members other than active admins. Never into one that already holds a TimeOff import (see [Safety](#safety)). |
| `--accept-mismatch` | Commit even when a current-year balance differs from TimeOff's. |

Exit codes: `0` for a dry run or a committed import, `1` when it was refused or rolled back, `2` for bad options.
It needs only `DATABASE_URL`.

**Requirements.** Node.js 22.13 or later, for the built-in `node:sqlite` module (no native add-on to install).
The Docker image uses `node:22-alpine` (22.23 when this was written), so the `migrate` container has it. Node
prints an "SQLite is an experimental feature" warning on some versions; the `pnpm` script silences it.

## How TimeOff maps onto OOOhm

| TimeOff | OOOhm |
| --- | --- |
| Company: name, time zone, `carry_over` | The target company keeps its name. Its time zone and working days become TimeOff's (TimeOff's company schedule), since day counting must match. `carry_over` becomes the allowance type's carryover cap (0 = off; very large values, TimeOff's "all", = no cap). |
| Department: name, `allowance`, `bossId` | A department by the same name (case-insensitive) is reused, else created. The **boss becomes the manager** of everyone in the department, except of themself. A reporting loop through departments (A's boss is B, B's is A) is broken by leaving one of them without a manager, and reported. |
| User: email, name + lastname | One person, email lowercased. Two TimeOff accounts with the same email in different case become one: the active one (else the one with most leave) is imported, the other and its leave are left out and listed under **Conflicts**. |
| User: `admin` | Role admin. Department bosses who are not admins get the role manager; everyone else employee. |
| User: `end_date` | Active while the end date is empty or after today, exactly as TimeOff decides who is employed. Inactive people are imported with their history but cannot sign in. |
| User: `activated` | Ignored for the active state: in TimeOff it only means the account has signed in once. Current employees who never signed in import as active and are listed in the warnings. |
| User: `auto_approve` | Self-approval. |
| User: `start_date` | The account's creation date, so OOOhm's year rollover knows when they joined. Someone whose start date is still ahead joins (for the rollover) on the import date, and gets a zero allowance row for each year before their start year and a pro-rated one for it, matching TimeOff's 0 before the start. |
| Leave type: name, colour, `use_allowance`, `limit` | Allowance types become the **pool type** (below). Others import untracked, or, with a `limit`, as a type whose yearly allowance is that limit. A type with the same name or code already in OOOhm is reused (the seeded "Sick Leave" for TimeOff's "Sick Leave"). Seeded types with no requests that TimeOff does not have are archived. Colours that are not hex values get a default. |
| Bank holidays | Company holidays (a date OOOhm already has is kept). Leave is counted against the company's calendar after the import: TimeOff's bank holidays plus any the company already had. A holiday only OOOhm has makes that leave cheaper in OOOhm, which shows up as a mismatch. |
| `user_allowance_adjustment`: `adjustment`, `carried_over_allowance` per year | The pool type's allowance row for that year: `adjustment_days` and `carried_over_days`. |
| Leave: `status` | `new` → pending, `approved` → approved, `rejected` → declined, `canceled` → cancelled, `pended revoke` → **approved** (TimeOff still counts it; listed in the warnings). The person can cancel it in OOOhm if it ends this year or later; approved leave of a past year cannot be cancelled by anyone, so an admin corrects that year with a balance adjustment instead. |
| Leave: dates and day parts | Requests with the same dates. OOOhm half days are single-day requests, so a leave from Monday afternoon to Wednesday morning becomes three: Monday (afternoon), Tuesday, Wednesday (morning). A leave that falls only on weekends and holidays is skipped. |
| Leave: approver, comments, decided/created times | Decided leave keeps TimeOff's approver as the decider. **Pending** leave is routed by OOOhm's own rule in the imported organisation (the person's manager, else the longest-standing other admin), so the manager sees it in their inbox; TimeOff's stored approver stays in the audit row. The employee's comment becomes the note, the approver's comment the decision note. |
| Department supervisors | Not imported: OOOhm has one approver per person (their manager, else their department's manager, else an admin), and an admin can set a department's manager after the import. The count is reported. |

Nobody gets a session, a password, an OAuth link or an email from the import. Active people sign in like any
invited person whose link expired: they type their email on the sign-in page and get a magic link. Access stays
invite-only.

## The allowance pool

This is the one real difference between the two models. **TimeOff has one allowance pool per person and year**,
shared by every leave type with "use allowance" on. **OOOhm keeps an allowance per leave type.**

The importer maps the pool onto one OOOhm leave type, the **pool type**. Its allowance rows carry the pool:

| OOOhm allowance row (pool type, one year) | From TimeOff |
| --- | --- |
| `days` | The person's department allowance |
| `adjustment_days` | That year's `adjustment`, plus TimeOff's pro-rating for a year the person started or left in |
| `carried_over_days` | That year's `carried_over_allowance` |

The pool type is first in the leave type order (the request form preselects it), and carryover follows TimeOff's
company setting. When every TimeOff department has the same allowance, that figure becomes the pool type's
default allowance, so people invited later are tracked from day one. Otherwise it has no default (a default would
replace the inherited department figure), every following year inherits the person's latest `days` (the year
rollover copies it forward), and the report warns (`pool_type_no_default`).

**Several types sharing the pool.** If TimeOff has, say, "Holiday" and "Training" both using the allowance, they
can only keep one balance as one OOOhm type. Splitting the pool into two allowances would have to invent how much
of it each type gets, and would change the number people see as left. So the importer refuses by default and
names the options. With `--merge-pool-types` both import as one type (named after the first, or `--pool-type`),
and each request from the other types keeps its original type name at the start of its note:
`[TimeOff: Training] Conference`. If some of those types should not really count against the allowance, turn
"use allowance" off for them in TimeOff and export again instead.

Without a default, new people invited later need an allowance for the pool type on their admin page (**Change
allowances**); until then the type is untracked for them, which means unlimited. Admins can also give the type a
default under **Leave types**, but a default replaces the inherited department figure for everyone without a row
for that year, so set it only if every department has the same allowance.

## Balance reconciliation

The import is accepted only if OOOhm shows every person the balance TimeOff shows them. For every imported
person and every year they have an allowance or leave in, the report has one row:

```
Email               Year   TimeOff     OOOhm    Diff
carol@example.com   2025         3         3       0
carol@example.com   2026        25        25       0
```

**TimeOff's side** is computed from the SQLite data by a pure module (`src/domain/timeoff/balance.ts`, unit tested
on hand-worked examples), following TimeOff's rules:

- total = department allowance + pro-rating + adjustment + carried over;
- pro-rating, in the year someone starts or leaves: `round(allowance × D / 365) − allowance`, where D is the whole
  days from the start date (or Jan 1) to the end date (or Dec 31); a full year changes nothing for ordinary
  allowances;
- used = days of **approved** (and pended-revoke) leave of allowance types: every date from start to end that is
  a working day of the person's schedule and not a bank holiday, split by calendar year, with TimeOff's half-day
  rule (below);
- remaining = total − used, or 0 for a year before the person started.

**OOOhm's side** is computed after the import, inside the same transaction, by the same balance code the
dashboard uses (`loadBalances` in `src/server/services/balances.ts`), and after running the year rollover's step
for last year, exactly as the nightly job will. The compared OOOhm figure is **total − approved days**: the balance
OOOhm shows, plus the pending days (TimeOff's "new" leave, which TimeOff does not subtract and OOOhm does, showing
them apart) and plus any days already carried into the next year (which OOOhm counts as spent in the year they
left, and TimeOff does not).

**The gate.** `--apply` rolls everything back if any **current-year** row differs, unless `--accept-mismatch` is
given. Earlier years are reported but do not block: they are closed, and only the current year's figure is what
people act on. The JSON report lists every mismatch with its likely cause:

| Cause in the report | What it means | What to do |
| --- | --- | --- |
| "TimeOff takes 0.5 day(s) in 2026 (its half-day rule), OOOhm counts 1" | TimeOff halves a leave's first or last day even when that day was a weekend or holiday, or fell in the other year of a leave over New Year. OOOhm counts the real cost. | Usually OOOhm is right. Either correct the leave in TimeOff and export again, or accept the difference and add an adjustment in OOOhm afterwards to match TimeOff. |
| "... on their own TimeOff schedule, ... on the company's working days" | The person had their own working week in TimeOff (part-time). OOOhm counts the company's working days for everyone. | Accept, and adjust their allowance in OOOhm to what was agreed; OOOhm v1 has no per-person schedule. |
| "Carried over into 2026: TimeOff stored X, OOOhm's year rollover computes Y" | TimeOff's carry-over has not been calculated for the current year yet (typical for an export taken in January: TimeOff then stores 0), or it ran before last year's leave was final, or was edited by hand. OOOhm recomputes it from last year every night. | If TimeOff stored 0, run its carry-over for the new year (in TimeOff) and export again. Otherwise check last year's leave; to keep OOOhm's figure, apply with `--accept-mismatch`, then correct with an adjustment in OOOhm if needed. |
| "OOOhm has no allowance for 2025 (outside their employment dates)" / "before their start date" | Leave dated outside the person's employment in TimeOff. | Fix the start or end date in TimeOff, or accept. |
| "... because the company already has a holiday in it that TimeOff does not" | The target company (usually with `--force`) has a holiday TimeOff lacks, so OOOhm charges less for that leave. | Add the holiday in TimeOff and export again, or delete it in OOOhm before importing, or accept. |

**Not compared, by design.**
- Department "accrued allowance": TimeOff shows only what has been earned so far; OOOhm grants the full year. Both
  sides are compared on the full-year figure, and the department is listed in the warnings.
- A yearly `limit` on an allowance type (a cap inside the pool): OOOhm keeps only the pool. Warned.
- Types without "use allowance" are not part of TimeOff's balance. Those with a `limit` become OOOhm allowances of
  that size, which TimeOff showed only as a cap.

## Safety

- **Dry run by default.** The dry run does everything the real run does, in one transaction, then rolls it back.
  What it reports is what `--apply` commits.
- **One transaction.** `--apply` commits everything or nothing: a refusal, a mismatch or a crash leaves the
  database as it was.
- **Once per file, once per company.** A committed import records an `import_runs` row with the file's SHA-256,
  its counts and the full report. Afterwards the same file is refused (dry run included), and so is any TimeOff
  import into that company, from any file, even with `--force`. A newer export always has a different hash (TimeOff
  writes its sessions to the same file, and `.backup` rewrites it), and importing it would insert every TimeOff
  leave a second time: pending requests twice in the approver's inbox, past years doubled. To redo an applied
  import, restore the backup taken before it ([deploy.md](deploy.md#restore)) and import the new export once.
- **Into a fresh company.** A company that already has leave requests, or members other than active admins (the
  seeded admin), is refused unless `--force`. With `--force`, someone whose email already exists in the company is
  updated, not duplicated: name, department and manager from TimeOff; role only ever raised; self-approval kept
  if either side had it; active state unchanged. An email that belongs to another company is left out and listed.
  `--force` does not match leave: all of TimeOff's leave history is added next to whatever requests the company
  already has. It is for a company that was used briefly before the import, never for importing a second time.
- **An admin remains.** If no active admin would exist afterwards (no TimeOff admin and no seeded one), it refuses.

## Audit and events

Every imported row writes an `audit_log` row in the import's transaction: `import.company`, `import.department`,
`import.leave_type`, `import.holiday`, `import.user`, `import.allowance`, `import.leave_request`, then
`import.completed` with the counts. An import is started by a person, so every one of them is that person's
change: the admin named by `--actor`, through the import (`actor_kind` `user`, `actor_id` the admin,
`actor_via` `timeoff_import`). Their `after` also carries `source: "import:timeoff"` and the TimeOff id.
**Admin → Audit log** shows them as "Imported: ...", by "<admin>, via time-off import".

The import does **not** replay its history to webhooks or adapters. It writes one outbox event,
`import.completed` (counts and the file's hash, no personal data; `actor` names the same admin, via
`timeoff_import`), documented in [api.md](api.md#types-and-payloads-version-1).
That holds even when the rollover step changes someone's carried-over days (a reported mismatch, committed only
with `--accept-mismatch`): the change is audited as `import.allowance` with reason `carryover`, without the
nightly rollover's `balance.adjusted` event.

## Getting the SQLite file out of TimeOff

TimeOff's default configuration keeps its data in `db.development.sqlite` in the application directory
(`config/db.json` names the file). Stop TimeOff first, or copy it with SQLite's own backup command so the copy is
consistent:

```bash
sqlite3 /path/to/timeoff/db.development.sqlite ".backup '/tmp/timeoff.sqlite'"
```

Leave TimeOff read-only (or stopped) from the export until the cutover: anything changed there afterwards is not
in the file.

## Try it locally

The tests build a synthetic TimeOff database (`tests/support/timeoff-fixture.ts`): two departments with different
allowances and bosses, an admin, adjustments and carried-over days, half days, a leave over New Year, one over a
bank holiday and a weekend, declined, cancelled and pended-revoke leave, a deactivated person, a current employee
who never signed in to TimeOff, a hire starting next year, a part-timer with
their own schedule, a sick type outside the allowance, a limited type, two types sharing the allowance, and the
same email in two cases. To try the command on it:

```bash
npx tsx --conditions=react-server --no-warnings=ExperimentalWarning tests/e2e/timeoff-fixture.mts /tmp/timeoff.sqlite
pnpm import:timeoff -- --file /tmp/timeoff.sqlite --company <id> --actor <seeded admin email> --merge-pool-types
```

Every row reconciles to 0. The fixture's leave is dated 2025 to 2026, and the importer reconciles against today's
year, so when run after 2026 the script also writes the carry-over rows TimeOff would have stored for each year
since (`tests/support/timeoff-carry-forward.ts`). Without them the current year's carried-over days would be 0 in
TimeOff and the full carry in OOOhm: the January-export mismatch in the table above.
