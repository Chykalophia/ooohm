import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { describeOverlap, type Overlap, overlapsFor, type TeamLeave } from "@/domain/overlap";

const leave = (userId: string, startDate: string, endDate: string, extra: Partial<TeamLeave> = {}): TeamLeave => ({
  userId,
  personName: userId[0].toUpperCase() + userId.slice(1),
  departmentId: "design",
  startDate,
  endDate,
  status: "approved",
  leaveTypeName: "PTO",
  ...extra,
});

const target = { requesterId: "ana", departmentId: "design", startDate: "2026-11-23", endDate: "2026-11-25" };

describe("overlapsFor", () => {
  test("keeps other people in the department whose leave touches the dates", () => {
    const got = overlapsFor(target, [
      leave("ana", "2026-11-23", "2026-11-23"),
      leave("bo", "2026-11-20", "2026-11-23"),
      leave("cy", "2026-11-25", "2026-11-30"),
      leave("di", "2026-11-26", "2026-11-27"),
      leave("ed", "2026-11-24", "2026-11-24", { departmentId: "sales" }),
    ]);
    assert.deepEqual(
      got.map((o) => o.userId),
      ["bo", "cy"],
    );
  });

  test("without a department, everyone counts", () => {
    const got = overlapsFor({ ...target, departmentId: null }, [leave("ed", "2026-11-24", "2026-11-24", { departmentId: "sales" })]);
    assert.deepEqual(
      got.map((o) => o.userId),
      ["ed"],
    );
  });

  test("one entry per person; approved leave wins over pending", () => {
    const got = overlapsFor(target, [
      leave("bo", "2026-11-23", "2026-11-23", { status: "pending", leaveTypeName: "Sick" }),
      leave("bo", "2026-11-24", "2026-11-24"),
      leave("cy", "2026-11-24", "2026-11-24", { status: "pending" }),
    ]);
    assert.deepEqual(got, [
      { userId: "bo", personName: "Bo", leaveTypeName: "PTO", pending: false },
      { userId: "cy", personName: "Cy", leaveTypeName: "PTO", pending: true },
    ]);
  });
});

describe("describeOverlap", () => {
  const o = (personName: string, pending = false): Overlap => ({ userId: personName, personName, leaveTypeName: "PTO", pending });

  test("nobody", () => {
    assert.equal(describeOverlap([], "Design"), "Nobody else in Design is off then.");
    assert.equal(describeOverlap([], null), "Nobody else is off then.");
  });

  test("one person, approved or not", () => {
    assert.equal(describeOverlap([o("Aisha")], "Design"), "Aisha is off then too.");
    assert.equal(describeOverlap([o("Aisha", true)], null), "Aisha (not approved yet) is off then too.");
  });

  test("a few people, then a count", () => {
    assert.equal(describeOverlap([o("Aisha"), o("Bo", true)], null), "Also off then: Aisha and Bo (not approved yet).");
    assert.equal(describeOverlap([o("A"), o("B"), o("C")], null), "Also off then: A, B and C.");
    assert.equal(describeOverlap([o("A"), o("B"), o("C"), o("D"), o("E")], null), "Also off then: A, B, C and 2 more.");
  });
});
