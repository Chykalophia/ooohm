import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  toCompanyDTO,
  toDepartmentDTO,
  toDepartmentSummaryDTO,
  toLeaveTypeDTO,
  toLeaveTypeSettingsDTO,
  type CompanyDTO,
  type DepartmentSummaryDTO,
  type LeaveTypeSettingsDTO,
} from "@/modules/organisation/application/dto";

/**
 * What the admin screens and other modules get from organisation. Each mapper copies
 * exactly the listed fields, so whatever else a query reads (a logo's bytes, a manager's
 * email, a type's allowance settings on the plain leave type) stays behind.
 */

const company: CompanyDTO = {
  id: "c-1",
  name: "Acme",
  timezone: "Europe/Warsaw",
  workingDays: [1, 2, 3, 4, 5],
  allowancePolicy: "annual_calendar_year",
  deletionGrace: false,
  managersSeeDetails: true,
  approvalMode: "required",
  colleagueVisibility: "everyone",
  departmentScoping: false,
  theme: "classic",
  accentColor: null,
  corners: "theme",
  requestStyle: "form",
  layout: "standard",
  logoSha256: null,
  logoType: null,
  logoWidth: null,
  logoHeight: null,
};

const leaveType: LeaveTypeSettingsDTO = {
  id: "lt-1",
  name: "PTO",
  code: "PTO",
  color: "#0f766e",
  countsAgainstAllowance: true,
  defaultAllowanceDays: 15,
  carryoverEnabled: false,
  carryoverMaxDays: null,
  isPaid: true,
  sortOrder: 0,
  archivedAt: null,
};

describe("toCompanyDTO", () => {
  test("is the company's settings and appearance, never the logo's bytes", () => {
    const dto = toCompanyDTO({ ...company, logo: new Uint8Array([1, 2, 3]), createdAt: new Date() } as CompanyDTO);
    assert.deepEqual(Object.keys(dto).sort(), Object.keys(company).sort());
    assert.ok(!("logo" in dto));
    assert.ok(!("createdAt" in dto));
    assert.deepEqual(dto, company);
  });
});

describe("toDepartmentDTO and toDepartmentSummaryDTO", () => {
  const department = { id: "d-1", name: "Support", managerId: "u-1", maxOff: 2 };

  test("a department is its name, manager and coverage limit", () => {
    assert.deepEqual(toDepartmentDTO({ ...department, companyId: "c-1" } as typeof department), department);
  });

  test("the admin list adds the manager's label and the head counts, not the manager's email", () => {
    const summary = { ...department, managerName: "Ana Ruiz", members: 3, assigned: 4 };
    const dto = toDepartmentSummaryDTO({ ...summary, managerEmail: "ana@acme.test" } as DepartmentSummaryDTO);
    assert.deepEqual(Object.keys(dto).sort(), ["assigned", "id", "managerId", "managerName", "maxOff", "members", "name"]);
    assert.deepEqual(dto, summary);
  });
});

describe("toLeaveTypeDTO", () => {
  test("names a leave type for other modules, without its allowance settings", () => {
    const dto = toLeaveTypeDTO(leaveType);
    assert.deepEqual(dto, { id: "lt-1", name: "PTO", code: "PTO", color: "#0f766e" });
    assert.ok(!("defaultAllowanceDays" in dto), "a person's default is read through loadAllowanceDefaults, never from the type");
  });
});

describe("toLeaveTypeSettingsDTO", () => {
  test("is every setting the leave type screens edit", () => {
    const dto = toLeaveTypeSettingsDTO({ ...leaveType, companyId: "c-1" } as LeaveTypeSettingsDTO);
    assert.deepEqual(Object.keys(dto).sort(), [
      "archivedAt",
      "carryoverEnabled",
      "carryoverMaxDays",
      "code",
      "color",
      "countsAgainstAllowance",
      "defaultAllowanceDays",
      "id",
      "isPaid",
      "name",
      "sortOrder",
    ]);
    assert.deepEqual(dto, leaveType);
  });
});
