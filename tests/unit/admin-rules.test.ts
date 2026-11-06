import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { canAdminister, assertCanAdminister } from "@/domain/admin-permissions";
import { ManagerApprovalRule, reassignApprover } from "@/domain/approval-rule";
import { isDomainError, type DomainErrorCode } from "@/domain/errors";
import {
  assertKeepsAnActiveAdmin,
  assertNotSelfDeactivation,
  assertValidManager,
  managerCandidates,
  normalizeDepartmentName,
  normalizeEmail,
  normalizePersonName,
  type ReportingLine,
} from "@/domain/people";

function throwsCode(fn: () => unknown, code: DomainErrorCode) {
  assert.throws(fn, (err) => isDomainError(err, code));
}

/** A company where `boss` manages `mid`, who manages `ana` and `ben`; `old` is inactive and reports to `ana`. */
function company(): Map<string, ReportingLine> {
  return new Map<string, ReportingLine>([
    ["boss", { managerId: null, isActive: true }],
    ["mid", { managerId: "boss", isActive: true }],
    ["ana", { managerId: "mid", isActive: true }],
    ["ben", { managerId: "mid", isActive: true }],
    ["old", { managerId: "ana", isActive: false }],
  ]);
}

test("only admins may administer", () => {
  assert.equal(canAdminister({ role: "admin" }), true);
  assert.equal(canAdminister({ role: "manager" }), false);
  assert.equal(canAdminister({ role: "employee" }), false);
  throwsCode(() => assertCanAdminister({ role: "manager" }), "forbidden");
  assert.doesNotThrow(() => assertCanAdminister({ role: "admin" }));
});

test("a manager must be an active member other than the person; none is fine", () => {
  const members = company();
  assert.doesNotThrow(() => assertValidManager("ana", null, members));
  assert.doesNotThrow(() => assertValidManager("ana", "ben", members), "a peer may manage");
  throwsCode(() => assertValidManager("ana", "ana", members), "invalid_manager");
  throwsCode(() => assertValidManager("ana", "old", members), "invalid_manager");
  throwsCode(() => assertValidManager("ana", "nobody", members), "invalid_manager");
  assert.doesNotThrow(() => assertValidManager(null, "boss", members), "a new person can report to anyone active");
  throwsCode(() => assertValidManager(null, "old", members), "invalid_manager");
});

test("no reporting loops, direct or indirect", () => {
  const members = company();
  throwsCode(() => assertValidManager("mid", "ana", members), "manager_cycle");
  throwsCode(() => assertValidManager("boss", "ana", members), "manager_cycle");
  throwsCode(() => assertValidManager("boss", "mid", members), "manager_cycle");
  assert.doesNotThrow(() => assertValidManager("mid", "ben", new Map([...members, ["ben", { managerId: null, isActive: true }]])));
});

test("a loop through an inactive person still counts, since reactivating them would close it", () => {
  const members = company();
  members.set("zed", { managerId: "old", isActive: true });
  // old (inactive) reports to ana; ana may not report to zed, who reports to old.
  throwsCode(() => assertValidManager("ana", "zed", members), "manager_cycle");
});

test("an existing loop elsewhere does not hang the check", () => {
  const members = new Map<string, ReportingLine>([
    ["x", { managerId: "y", isActive: true }],
    ["y", { managerId: "x", isActive: true }],
    ["p", { managerId: null, isActive: true }],
  ]);
  assert.doesNotThrow(() => assertValidManager("p", "x", members));
});

test("manager candidates leave out the person, inactive people and everyone who reports to them", () => {
  assert.deepEqual(managerCandidates("mid", company()), ["boss"]);
  assert.deepEqual(managerCandidates("ana", company()), ["boss", "mid", "ben"]);
  assert.deepEqual(managerCandidates(null, company()), ["boss", "mid", "ana", "ben"]);
});

test("the last active admin cannot be demoted or deactivated; with another admin they can", () => {
  const admin = { role: "admin", isActive: true } as const;
  const change = (after: { role: "admin" | "manager" | "employee"; isActive: boolean }) => ({ personId: "a1", before: admin, after });
  throwsCode(() => assertKeepsAnActiveAdmin(change({ role: "employee", isActive: true }), ["a1"]), "last_admin");
  throwsCode(() => assertKeepsAnActiveAdmin(change({ role: "admin", isActive: false }), ["a1"]), "last_admin");
  throwsCode(() => assertKeepsAnActiveAdmin(change({ role: "manager", isActive: true }), []), "last_admin");
  assert.doesNotThrow(() => assertKeepsAnActiveAdmin(change({ role: "employee", isActive: true }), ["a1", "a2"]));
  assert.doesNotThrow(() => assertKeepsAnActiveAdmin(change({ role: "admin", isActive: false }), ["a2", "a1"]));
  assert.doesNotThrow(() => assertKeepsAnActiveAdmin(change({ role: "admin", isActive: true }), ["a1"]), "staying an admin is fine");
});

test("the last-admin guard ignores changes to people who hold no admin seat", () => {
  const person = (before: { role: "admin" | "employee"; isActive: boolean }) => ({ personId: "p", before, after: { role: "employee" as const, isActive: false } });
  assert.doesNotThrow(() => assertKeepsAnActiveAdmin(person({ role: "employee", isActive: true }), ["a1"]));
  assert.doesNotThrow(() => assertKeepsAnActiveAdmin(person({ role: "admin", isActive: false }), []), "an inactive admin holds no seat");
});

test("admins cannot deactivate themselves", () => {
  throwsCode(() => assertNotSelfDeactivation("a1", "a1"), "self_change_not_allowed");
  assert.doesNotThrow(() => assertNotSelfDeactivation("a1", "a2"));
});

test("emails are trimmed, lowercased and checked by the rule Better Auth's magic link applies", () => {
  assert.equal(normalizeEmail("  Ana.Smith@Example.COM "), "ana.smith@example.com");
  assert.equal(normalizeEmail("o'neil+ooo@mail.example.co.uk"), "o'neil+ooo@mail.example.co.uk");
  const bad = [
    "",
    "ana",
    "ana@",
    "@example.com",
    "ana@example",
    "a na@example.com",
    `${"a".repeat(250)}@x.co`,
    // Accepted by a loose pattern but refused by Better Auth: the invite would
    // create an account that can never get a sign-in link.
    "a!b@c.de",
    "jo@x.c",
    "a..b@c.de",
    "x@y.z,w",
    "a<x@evil.com>",
  ];
  for (const email of bad) throwsCode(() => normalizeEmail(email), "invalid_input");
});

test("normalizeEmail accepts exactly what z.email() (Better Auth's body schema) accepts", () => {
  const samples = [
    "ana@example.com",
    "ana.smith@example.com",
    "a_b-c+d@sub.example.org",
    "o'neil@example.ie",
    "ana@example",
    "a!b@c.de",
    "jo@x.c",
    "a..b@c.de",
    ".ana@example.com",
    "ana.@example.com",
    "ana@-example.com",
    "ana@example.c0m",
    "x@y.z,w",
    "a<x@evil.com>",
    "ana@exa_mple.com",
    "\"quoted\"@example.com",
  ];
  for (const sample of samples) {
    let ours = true;
    try {
      normalizeEmail(sample);
    } catch {
      ours = false;
    }
    assert.equal(ours, z.email().safeParse(sample).success, sample);
  }
});

test("names and department names are one trimmed line, required, and capped", () => {
  assert.equal(normalizePersonName("  Ana \n  Smith "), "Ana Smith");
  throwsCode(() => normalizePersonName("   "), "invalid_input");
  throwsCode(() => normalizePersonName("x".repeat(101)), "invalid_input");
  assert.equal(normalizeDepartmentName(" Ops  team "), "Ops team");
  throwsCode(() => normalizeDepartmentName(""), "invalid_input");
  throwsCode(() => normalizeDepartmentName("x".repeat(61)), "invalid_input");
});

const rule = new ManagerApprovalRule();
const at = (iso: string) => new Date(iso);

test("reassignment never self-approves: a self-approver's request goes to their manager", () => {
  const approver = reassignApprover(rule, {
    requester: { id: "r", role: "employee", canSelfApprove: true, managerId: "m" },
    manager: { id: "m", isActive: true, createdAt: at("2026-01-01") },
    departmentManager: null,
    admins: [],
  });
  assert.equal(approver, "m");
});

test("reassignment falls back to the longest-standing other admin, then the requester if admin, then nobody", () => {
  const admins = [
    { id: "a2", isActive: true, createdAt: at("2026-02-01") },
    { id: "a1", isActive: true, createdAt: at("2026-01-01") },
  ];
  const requester = { id: "r", role: "employee", canSelfApprove: false, managerId: "gone" } as const;
  const inactiveManager = { id: "gone", isActive: false, createdAt: at("2025-01-01") };
  assert.equal(reassignApprover(rule, { requester, manager: inactiveManager, departmentManager: null, admins }), "a1");
  assert.equal(
    reassignApprover(rule, { requester: { ...requester, id: "a1", role: "admin" }, manager: inactiveManager, departmentManager: null, admins: [admins[1]] }),
    "a1",
    "an admin with no other admin left decides their own",
  );
  assert.equal(reassignApprover(rule, { requester, manager: inactiveManager, departmentManager: null, admins: [] }), null);
});
