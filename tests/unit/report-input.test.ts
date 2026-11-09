import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readReportQuery, searchParamsRecord } from "@/app/_lib/report-input";

const DEPT = "0b6f1c1e-6f43-4d4b-9a51-0d6a3c1b2e7f";
const read = (query: string) => readReportQuery(searchParamsRecord(new URLSearchParams(query)));

describe("report query", () => {
  test("reads a year and a department", () => {
    assert.deepEqual(read(`year=2025&department=${DEPT}`), { year: 2025, departmentId: DEPT });
  });

  test("nothing given means the default view", () => {
    assert.deepEqual(read(""), { year: undefined, departmentId: undefined });
  });

  test("a repeated key counts as missing, for the export as for the page", () => {
    assert.deepEqual(read("year=2025&year=2026"), { year: undefined, departmentId: undefined });
    assert.deepEqual(read(`year=2025&department=${DEPT}&department=${DEPT}`), { year: 2025, departmentId: undefined });
    assert.deepEqual(readReportQuery({ year: ["2025", "2026"] }), { year: undefined, departmentId: undefined });
  });

  test("a malformed value counts as missing", () => {
    assert.deepEqual(read("year=99999&department=nope"), { year: undefined, departmentId: undefined });
  });

  test("searchParamsRecord keeps a key given once as a string", () => {
    assert.deepEqual(searchParamsRecord(new URLSearchParams("a=1&b=2&b=3")), { a: "1", b: ["2", "3"] });
  });
});
