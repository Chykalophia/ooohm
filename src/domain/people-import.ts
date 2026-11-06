/**
 * Bulk import of people from a CSV file an admin uploads: reading the file, and planning
 * what importing it would do. Pure; `admin-people-import` loads the facts a plan needs
 * (under the company lock when it applies one) and writes what the plan says.
 *
 * The file has one person per row and these columns, in any order (headers are matched
 * ignoring case, spaces and hyphens; other columns are ignored):
 *
 * | Column | Required | |
 * | --- | --- | --- |
 * | `email` | yes | Their sign-in address. |
 * | `name` | yes | As it should appear to others. |
 * | `role` | no | `employee` (default), `manager` or `admin`. |
 * | `department` | no | A department name; one the company does not have yet is created. |
 * | `manager_email` | no | Who approves their requests: someone in the company, or another row of the file. |
 * | `can_self_approve` | no | `yes` or `no` (default `no`). |
 *
 * A plan sorts every row into one of three outcomes: added, skipped (the email already has
 * an account, in this company or another; the reason never says which), or a problem. A
 * file with any problem is not imported at all, so a fixed file can simply be uploaded again.
 */
import { ROLES, type Role } from "./actor";
import { parseCsv, toCsv } from "./csv";
import { DomainError, isDomainError } from "./errors";
import { DEPARTMENT_NAME_MAX_LENGTH, isRole, normalizeDepartmentName, normalizeEmail, normalizePersonName } from "./people";

/** Most people one file may hold. */
export const PEOPLE_IMPORT_MAX_ROWS = 500;

/** The columns of the import file, in the order the sample uses. */
export const PEOPLE_IMPORT_COLUMNS = ["email", "name", "role", "department", "manager_email", "can_self_approve"] as const;

type Column = (typeof PEOPLE_IMPORT_COLUMNS)[number];

/** Other spellings accepted for a column, after {@link headerKey}. */
const ALIASES: Record<string, Column> = {
  e_mail: "email",
  email_address: "email",
  full_name: "name",
  manager: "manager_email",
  manager_e_mail: "manager_email",
  self_approve: "can_self_approve",
  approves_own_requests: "can_self_approve",
};

const REQUIRED: readonly Column[] = ["email", "name"];

/** One row of the file, as written (trimmed), with its line number in the file. */
export interface PeopleCsvRow {
  line: number;
  email: string;
  name: string;
  role: string;
  department: string;
  managerEmail: string;
  canSelfApprove: string;
}

function headerKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * Reads an import file into rows. Fully blank lines are skipped; every row keeps the line
 * number a spreadsheet would show for it (the header is line 1; a quoted cell with a line
 * break counts as one line).
 *
 * @returns The rows, and the headers of columns that were ignored.
 * @throws DomainError `invalid_input` (with a message to show) for an unreadable or empty
 *   file, a missing `email` or `name` column, a column named twice, or more than
 *   {@link PEOPLE_IMPORT_MAX_ROWS} people.
 */
export function readPeopleCsv(text: string): { rows: PeopleCsvRow[]; ignoredColumns: string[] } {
  const [header, ...body] = parseCsv(text);
  if (!header || header.every((h) => h.trim() === "")) throw new DomainError("invalid_input", "The file is empty.");

  const index = new Map<Column, number>();
  const ignoredColumns: string[] = [];
  header.forEach((raw, i) => {
    const key = headerKey(raw);
    const column = (PEOPLE_IMPORT_COLUMNS as readonly string[]).includes(key) ? (key as Column) : ALIASES[key];
    if (!column) {
      if (raw.trim() !== "") ignoredColumns.push(raw.trim());
      return;
    }
    if (index.has(column)) throw new DomainError("invalid_input", `The ${column} column appears twice.`);
    index.set(column, i);
  });
  const missing = REQUIRED.filter((c) => !index.has(c));
  if (missing.length > 0) {
    throw new DomainError("invalid_input", `The file needs ${missing.map((c) => `a ${c} column`).join(" and ")}. Start from the sample file.`);
  }

  const cell = (cells: string[], column: Column) => {
    const i = index.get(column);
    return i === undefined ? "" : (cells[i] ?? "").trim();
  };
  const rows: PeopleCsvRow[] = [];
  body.forEach((cells, i) => {
    if (cells.every((c) => c.trim() === "")) return;
    rows.push({
      line: i + 2,
      email: cell(cells, "email"),
      name: cell(cells, "name"),
      role: cell(cells, "role"),
      department: cell(cells, "department"),
      managerEmail: cell(cells, "manager_email"),
      canSelfApprove: cell(cells, "can_self_approve"),
    });
  });
  if (rows.length === 0) throw new DomainError("invalid_input", "The file has a header but no people.");
  if (rows.length > PEOPLE_IMPORT_MAX_ROWS) {
    throw new DomainError("invalid_input", `One file can hold up to ${PEOPLE_IMPORT_MAX_ROWS} people. Split it and import each part.`);
  }
  return { rows, ignoredColumns };
}

/** What a plan needs to know about the company, and about accounts anywhere. */
export interface ImportFacts {
  /** The company's people (not deleted ones), by lowercased email. */
  members: ReadonlyMap<string, { id: string; isActive: boolean }>;
  /** Of the file's emails, those that already have an account in any company (lowercased). */
  takenEmails: ReadonlySet<string>;
  /** The company's departments, by lowercased name. */
  departments: ReadonlyMap<string, { id: string; name: string }>;
}

/** Who a planned person reports to: someone already in the company, or another row being added. */
export type PlannedManager = { kind: "member"; id: string; email: string } | { kind: "row"; email: string };

export interface PlannedPerson {
  email: string;
  name: string;
  role: Role;
  /** An existing department (`id`), or one to create (`id: null`); `null` for none. */
  department: { id: string | null; name: string } | null;
  manager: PlannedManager | null;
  canSelfApprove: boolean;
}

export type PlannedRow =
  | { line: number; email: string; status: "add"; person: PlannedPerson }
  | { line: number; email: string; status: "skip"; reason: string }
  | { line: number; email: string; status: "error"; problems: string[] };

export interface PeopleImportPlan {
  /** Every row of the file, in file order. */
  rows: PlannedRow[];
  /** Departments the import would create, by name as first written. */
  newDepartments: string[];
  adds: number;
  skips: number;
  errors: number;
}

const YES = new Set(["yes", "y", "true", "1"]);
const NO = new Set(["no", "n", "false", "0", ""]);

/** The message a domain rule refused `value` with, or `fallback`. */
function refusal(work: () => unknown, fallback: string): string | null {
  try {
    work();
    return null;
  } catch (err) {
    if (isDomainError(err, "invalid_input")) return err.message || fallback;
    throw err;
  }
}

const ALREADY_HERE = "Already has an account, so left as is.";

/**
 * Decides what importing `rows` would do. Every problem on a row is reported, not only
 * the first. Beyond each cell's own rules:
 *
 * - An email listed twice is a problem on the later line.
 * - An email that already has an account is skipped, not a problem: re-uploading a file
 *   after fixing it adds only those not added yet.
 * - A manager is looked up among the company's people first, then among the rows being
 *   added. They must be active, and not the person themself. A row whose manager's row
 *   has a problem has one too, since that manager will not exist; and reporting lines
 *   that loop back on themselves are a problem on every row of the loop.
 */
export function planPeopleImport(rows: readonly PeopleCsvRow[], facts: ImportFacts): PeopleImportPlan {
  type Draft = { line: number; email: string; problems: string[]; skip: boolean; person: PlannedPerson; managerEmail: string | null };
  const firstLine = new Map<string, number>();
  const newDepartments = new Map<string, string>();

  const drafts: Draft[] = rows.map((row) => {
    const problems: string[] = [];
    let email = row.email.trim().toLowerCase();
    const emailProblem = refusal(() => (email = normalizeEmail(row.email)), "That isn't an email address.");
    if (emailProblem) problems.push(row.email === "" ? "The email is missing." : `“${row.email}” isn't an email address.`);
    else if (firstLine.has(email)) problems.push(`This email is also on line ${firstLine.get(email)}.`);
    else firstLine.set(email, row.line);

    let name = "";
    const nameProblem = refusal(() => (name = normalizePersonName(row.name)), "The name is missing.");
    if (nameProblem) problems.push(row.name.trim() === "" ? "The name is missing." : nameProblem);

    const roleText = row.role.trim().toLowerCase();
    const role: Role = roleText === "" ? "employee" : isRole(roleText) ? roleText : "employee";
    if (roleText !== "" && !isRole(roleText)) problems.push(`Role must be ${ROLES.join(", ").replace(/, (\w+)$/, " or $1")}, not “${row.role}”.`);

    const approval = row.canSelfApprove.trim().toLowerCase();
    if (!YES.has(approval) && !NO.has(approval)) problems.push(`can_self_approve must be yes or no, not “${row.canSelfApprove}”.`);

    let department: PlannedPerson["department"] = null;
    if (row.department.trim() !== "") {
      let deptName = "";
      const deptProblem = refusal(() => (deptName = normalizeDepartmentName(row.department)), "");
      if (deptProblem) problems.push(`Department names are up to ${DEPARTMENT_NAME_MAX_LENGTH} characters.`);
      else {
        const key = deptName.toLowerCase();
        const existing = facts.departments.get(key);
        department = existing ? { id: existing.id, name: existing.name } : { id: null, name: newDepartments.get(key) ?? deptName };
        if (!existing && !newDepartments.has(key)) newDepartments.set(key, deptName);
      }
    }

    let managerEmail: string | null = null;
    if (row.managerEmail.trim() !== "") {
      const managerProblem = refusal(() => (managerEmail = normalizeEmail(row.managerEmail)), "");
      if (managerProblem) problems.push(`The manager's email “${row.managerEmail}” isn't an email address.`);
      else if (managerEmail === email) problems.push("Someone can't be their own manager.");
    }

    // Someone already here is left as is, so the rest of their row does not matter.
    const skip = !emailProblem && firstLine.get(email) === row.line && facts.takenEmails.has(email);
    return {
      line: row.line,
      email,
      problems: skip ? [] : problems,
      skip,
      managerEmail,
      person: { email, name, role, department, manager: null, canSelfApprove: YES.has(approval) },
    };
  });

  // Only rows that are to be added can be another row's manager: the first row of each email.
  const byEmail = new Map(drafts.filter((d) => firstLine.get(d.email) === d.line && !d.skip).map((d) => [d.email, d]));

  for (const d of drafts) {
    if (d.skip || d.managerEmail === null || d.problems.length > 0) continue;
    const member = facts.members.get(d.managerEmail);
    if (member) {
      if (member.isActive) d.person.manager = { kind: "member", id: member.id, email: d.managerEmail };
      else d.problems.push("The manager is deactivated.");
    } else if (byEmail.has(d.managerEmail)) d.person.manager = { kind: "row", email: d.managerEmail };
    else d.problems.push(`Nobody with the manager's email (${d.managerEmail}) is in OOOhm or in this file.`);
  }

  // Loops among the rows: walk up from each row; a walk that returns to its start is a loop.
  for (const d of drafts) {
    if (d.problems.length > 0 || d.person.manager?.kind !== "row") continue;
    const seen = new Set<string>();
    for (let at: Draft | undefined = d; at?.person.manager?.kind === "row"; at = byEmail.get(at.person.manager.email)) {
      if (seen.has(at.email)) break;
      seen.add(at.email);
      if (at.person.manager.email === d.email) {
        d.problems.push("The managers in this file loop back to this person.");
        break;
      }
    }
  }

  // A row whose manager's row fails fails too, until nothing changes.
  for (let changed = true; changed; ) {
    changed = false;
    for (const d of drafts) {
      if (d.problems.length > 0 || d.person.manager?.kind !== "row") continue;
      const manager = byEmail.get(d.person.manager.email);
      if (manager && manager.problems.length > 0) {
        d.problems.push(`The manager's row (line ${manager.line}) has a problem.`);
        changed = true;
      }
    }
  }

  const planned: PlannedRow[] = drafts.map((d) =>
    d.problems.length > 0
      ? { line: d.line, email: d.email, status: "error", problems: d.problems }
      : d.skip
        ? { line: d.line, email: d.email, status: "skip", reason: ALREADY_HERE }
        : { line: d.line, email: d.email, status: "add", person: d.person },
  );
  const errors = planned.filter((r) => r.status === "error").length;
  const adds = planned.filter((r) => r.status === "add").length;
  // A department only an erroring row names is still listed: nothing is created until every row is fine.
  return { rows: planned, newDepartments: [...newDepartments.values()], adds, skips: planned.length - adds - errors, errors };
}

/**
 * The people a plan adds, each after the person they report to (when that is another
 * row), so every manager exists by the time their reports are created.
 */
export function creationOrder(plan: PeopleImportPlan): PlannedPerson[] {
  const adds = new Map(plan.rows.flatMap((r) => (r.status === "add" ? [[r.email, r.person] as const] : [])));
  const placed = new Set<string>();
  const order: PlannedPerson[] = [];
  const place = (person: PlannedPerson) => {
    if (placed.has(person.email)) return;
    placed.add(person.email);
    const manager = person.manager?.kind === "row" ? adds.get(person.manager.email) : undefined;
    if (manager) place(manager);
    order.push(person);
  };
  for (const person of adds.values()) place(person);
  return order;
}

/** The sample file's people: a small team that shows every column, including a manager listed later in the file. */
export const PEOPLE_IMPORT_SAMPLE: readonly (readonly string[])[] = [
  ["alex.rivera@example.com", "Alex Rivera", "employee", "Engineering", "sam.chen@example.com", "no"],
  ["sam.chen@example.com", "Sam Chen", "manager", "Engineering", "", "no"],
  ["jordan.lee@example.com", "Jordan Lee", "employee", "Design", "sam.chen@example.com", ""],
  ["priya.patel@example.com", "Priya Patel", "admin", "Operations", "", "yes"],
  ["casey.morgan@example.com", "Casey Morgan", "", "", "priya.patel@example.com", ""],
];

/** The sample import file, ready to download and fill in. */
export function peopleImportSampleCsv(): string {
  return toCsv(PEOPLE_IMPORT_COLUMNS, PEOPLE_IMPORT_SAMPLE);
}
