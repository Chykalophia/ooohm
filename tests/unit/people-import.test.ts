import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseCsv, toCsv } from "@/domain/csv";
import { isDomainError } from "@/domain/errors";
import {
  type ImportFacts,
  PEOPLE_IMPORT_COLUMNS,
  PEOPLE_IMPORT_MAX_ROWS,
  PEOPLE_IMPORT_SAMPLE,
  creationOrder,
  peopleImportSampleCsv,
  planPeopleImport,
  readPeopleCsv,
} from "@/domain/people-import";

const NO_FACTS: ImportFacts = { members: new Map(), takenEmails: new Set(), departments: new Map() };

function plan(csv: string, facts: Partial<ImportFacts> = {}) {
  return planPeopleImport(readPeopleCsv(csv).rows, { ...NO_FACTS, ...facts });
}

function problemsOn(p: ReturnType<typeof plan>, line: number): string[] {
  const row = p.rows.find((r) => r.line === line);
  assert.ok(row, `no row on line ${line}`);
  return row.status === "error" ? row.problems : [];
}

describe("parseCsv", () => {
  test("reads plain rows, quoted cells, escaped quotes and line breaks inside quotes", () => {
    assert.deepEqual(parseCsv('a,b,c\r\n1,"two, three","say ""hi"""\n"multi\nline",,x'), [
      ["a", "b", "c"],
      ["1", "two, three", 'say "hi"'],
      ["multi\nline", "", "x"],
    ]);
  });

  test("drops a byte order mark and a trailing newline, and keeps empty trailing cells", () => {
    assert.deepEqual(parseCsv("﻿a,b\r\n1,\r\n"), [
      ["a", "b"],
      ["1", ""],
    ]);
  });

  test("reads lone CR line endings (old spreadsheet exports)", () => {
    assert.deepEqual(parseCsv("a,b\r1,2\r"), [
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  test("refuses a quote that is never closed", () => {
    assert.throws(() => parseCsv('a,b\n"open,1'), (err) => isDomainError(err, "invalid_input"));
  });

  test("reads back what toCsv writes", () => {
    const rows = [
      ["name", "note"],
      ["Ann, Jr.", 'says "hi"'],
      ["Bo", "two\nlines"],
    ];
    assert.deepEqual(parseCsv(toCsv(rows[0], rows.slice(1))), rows);
  });
});

describe("readPeopleCsv", () => {
  test("maps headers by name in any order and case, with spaces or hyphens", () => {
    const { rows } = readPeopleCsv("Name,E-mail,Manager Email,ROLE,Department,Can Self Approve\nAnn Lee,ann@example.com,bo@example.com,manager,Design,yes\n");
    assert.deepEqual(rows, [
      { line: 2, email: "ann@example.com", name: "Ann Lee", role: "manager", department: "Design", managerEmail: "bo@example.com", canSelfApprove: "yes" },
    ]);
  });

  test("only email and name are required; missing optional columns read as blank", () => {
    const { rows, ignoredColumns } = readPeopleCsv("email,name,start date\nann@example.com,Ann,2026-01-01\n");
    assert.deepEqual(rows, [{ line: 2, email: "ann@example.com", name: "Ann", role: "", department: "", managerEmail: "", canSelfApprove: "" }]);
    assert.deepEqual(ignoredColumns, ["start date"]);
  });

  test("skips blank lines but keeps each row's line number in the file", () => {
    const { rows } = readPeopleCsv("email,name\n\nann@example.com,Ann\n , \nbo@example.com,Bo\n");
    assert.deepEqual(
      rows.map((r) => [r.line, r.email]),
      [
        [3, "ann@example.com"],
        [5, "bo@example.com"],
      ],
    );
  });

  test("refuses a file without an email or name column, saying which", () => {
    assert.throws(
      () => readPeopleCsv("email,role\nann@example.com,employee\n"),
      (err) => isDomainError(err, "invalid_input") && /name/.test((err as Error).message),
    );
    assert.throws(
      () => readPeopleCsv("name\nAnn\n"),
      (err) => isDomainError(err, "invalid_input") && /email/.test((err as Error).message),
    );
  });

  test("refuses an empty file, and one with no people in it", () => {
    for (const csv of ["", "\n\n", "email,name\n"]) {
      assert.throws(() => readPeopleCsv(csv), (err) => isDomainError(err, "invalid_input"), JSON.stringify(csv));
    }
  });

  test("refuses a column named twice", () => {
    assert.throws(() => readPeopleCsv("email,name,Email\na@example.com,A,b@example.com\n"), (err) => isDomainError(err, "invalid_input"));
  });

  test(`refuses more than ${PEOPLE_IMPORT_MAX_ROWS} people in one file`, () => {
    const body = Array.from({ length: PEOPLE_IMPORT_MAX_ROWS + 1 }, (_, i) => `p${i}@example.com,P ${i}`).join("\n");
    assert.throws(() => readPeopleCsv(`email,name\n${body}\n`), (err) => isDomainError(err, "invalid_input"));
    const ok = Array.from({ length: PEOPLE_IMPORT_MAX_ROWS }, (_, i) => `p${i}@example.com,P ${i}`).join("\n");
    assert.equal(readPeopleCsv(`email,name\n${ok}\n`).rows.length, PEOPLE_IMPORT_MAX_ROWS);
  });
});

describe("planPeopleImport", () => {
  test("normalizes each person: email lowercased, name on one line, role and approval defaults", () => {
    const p = plan("email,name,role,can_self_approve\n  Ann@Example.COM , Ann   Lee ,,\nbo@example.com,Bo,Admin,TRUE\n");
    assert.deepEqual(
      p.rows.map((r) => (r.status === "add" ? [r.person.email, r.person.name, r.person.role, r.person.canSelfApprove] : r.status)),
      [
        ["ann@example.com", "Ann Lee", "employee", false],
        ["bo@example.com", "Bo", "admin", true],
      ],
    );
    assert.deepEqual([p.adds, p.skips, p.errors], [2, 0, 0]);
  });

  test("accepts yes/no, true/false, y/n and 1/0 for self-approval, and refuses anything else", () => {
    const p = plan("email,name,can_self_approve\na@x.io,A,Y\nb@x.io,B,no\nc@x.io,C,1\nd@x.io,D,0\ne@x.io,E,maybe\n");
    assert.deepEqual(
      p.rows.map((r) => (r.status === "add" ? r.person.canSelfApprove : r.status)),
      [true, false, true, false, "error"],
    );
  });

  test("reports every problem on a row, by line", () => {
    const p = plan("email,name,role,manager_email\nnot-an-email,,boss,also-bad\n");
    assert.equal(p.errors, 1);
    assert.equal(problemsOn(p, 2).length, 4);
  });

  test("skips an email that already has an account, without saying where", () => {
    const p = plan("email,name\nann@example.com,Ann\nzed@example.com,Zed\n", { takenEmails: new Set(["ann@example.com"]) });
    assert.deepEqual(
      p.rows.map((r) => r.status),
      ["skip", "add"],
    );
    assert.deepEqual([p.adds, p.skips, p.errors], [1, 1, 0]);
  });

  test("flags an email listed twice on the later line, naming the first", () => {
    const p = plan("email,name\nann@example.com,Ann\nANN@example.com,Ann again\n");
    assert.equal(p.rows[0].status, "add");
    assert.match(problemsOn(p, 3).join(" "), /line 2/);
  });

  test("matches departments by name ignoring case, and lists the ones to create once", () => {
    const p = plan("email,name,department\na@x.io,A,design\nb@x.io,B,Sales\nc@x.io,C,sales\nd@x.io,D,\n", {
      departments: new Map([["design", { id: "d-1", name: "Design" }]]),
    });
    assert.deepEqual(
      p.rows.map((r) => (r.status === "add" ? r.person.department : r.status)),
      [{ id: "d-1", name: "Design" }, { id: null, name: "Sales" }, { id: null, name: "Sales" }, null],
    );
    assert.deepEqual(p.newDepartments, ["Sales"]);
  });

  test("resolves a manager among the company's people or another row of the file", () => {
    const p = plan("email,name,manager_email\nbo@x.io,Bo,boss@x.io\nann@x.io,Ann,BO@x.io\n", {
      members: new Map([["boss@x.io", { id: "u-boss", isActive: true }]]),
      takenEmails: new Set(["boss@x.io"]),
    });
    assert.deepEqual(
      p.rows.map((r) => (r.status === "add" ? r.person.manager : r.status)),
      [
        { kind: "member", id: "u-boss", email: "boss@x.io" },
        { kind: "row", email: "bo@x.io" },
      ],
    );
  });

  test("a row can name a manager who appears later in the file", () => {
    const p = plan("email,name,manager_email\nann@x.io,Ann,bo@x.io\nbo@x.io,Bo,\n");
    assert.equal(p.errors, 0);
    assert.deepEqual(
      creationOrder(p).map((r) => r.email),
      ["bo@x.io", "ann@x.io"],
    );
  });

  test("refuses an unknown or deactivated manager, and someone managing themself", () => {
    const p = plan("email,name,manager_email\na@x.io,A,ghost@x.io\nb@x.io,B,gone@x.io\nc@x.io,C,c@x.io\n", {
      members: new Map([["gone@x.io", { id: "u-gone", isActive: false }]]),
      takenEmails: new Set(["gone@x.io"]),
    });
    assert.deepEqual([p.adds, p.errors], [0, 3]);
  });

  test("a manager on a row with problems makes their reports' rows fail too", () => {
    const p = plan("email,name,manager_email,role\nbo@x.io,Bo,,wizard\nann@x.io,Ann,bo@x.io,\ncy@x.io,Cy,ann@x.io,\n");
    assert.deepEqual(
      p.rows.map((r) => r.status),
      ["error", "error", "error"],
    );
    assert.match(problemsOn(p, 3).join(" "), /line 2/);
    assert.match(problemsOn(p, 4).join(" "), /line 3/);
  });

  test("refuses reporting lines that loop back, on every row of the loop", () => {
    const p = plan("email,name,manager_email\na@x.io,A,b@x.io\nb@x.io,B,c@x.io\nc@x.io,C,a@x.io\nd@x.io,D,\n");
    assert.deepEqual(
      p.rows.map((r) => r.status),
      ["error", "error", "error", "add"],
    );
  });

  test("a manager whose row is skipped resolves only when they are in this company", () => {
    // ann@ has an account in this company; bo@ has one elsewhere (not a member here).
    const facts = {
      members: new Map([["ann@x.io", { id: "u-ann", isActive: true }]]),
      takenEmails: new Set(["ann@x.io", "bo@x.io"]),
    };
    const p = plan("email,name,manager_email\nann@x.io,Ann,\nbo@x.io,Bo,\ncy@x.io,Cy,ann@x.io\ndi@x.io,Di,bo@x.io\n", facts);
    assert.deepEqual(
      p.rows.map((r) => r.status),
      ["skip", "skip", "add", "error"],
    );
  });

  test("creation order puts every manager before the people who report to them", () => {
    const p = plan("email,name,manager_email\nd@x.io,D,c@x.io\nc@x.io,C,b@x.io\nb@x.io,B,a@x.io\na@x.io,A,\n");
    assert.deepEqual(
      creationOrder(p).map((r) => r.email),
      ["a@x.io", "b@x.io", "c@x.io", "d@x.io"],
    );
  });
});

describe("the sample file", () => {
  test("has exactly the import's columns, in order", () => {
    const [header] = parseCsv(peopleImportSampleCsv());
    assert.deepEqual(header, [...PEOPLE_IMPORT_COLUMNS]);
  });

  test("imports cleanly into an empty company, managers resolved within the file", () => {
    const p = plan(peopleImportSampleCsv());
    assert.deepEqual([p.adds, p.skips, p.errors], [PEOPLE_IMPORT_SAMPLE.length, 0, 0]);
    assert.ok(p.rows.some((r) => r.status === "add" && r.person.manager?.kind === "row"));
    assert.ok(p.newDepartments.length > 0);
  });
});
