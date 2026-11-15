import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompanySettingsInput } from "@/shared/kernel/company-settings";
import type { CompanyChange, CompanyDTO } from "@/modules/organisation";
import { addLeaveFor } from "@/modules/leave/application/use-cases/add-leave-for";
import { NOTHING_RECOUNTED } from "@/modules/leave/application/use-cases/recount-leave";
import { type UpdateCompanySettingsDeps, updateCompanySettings } from "@/modules/leave/application/use-cases/update-company-settings";
import { unwrap } from "@/shared/lib/result";
import { actorFor, ANA, BOSS, COMPANY, type LeaveKit, leaveKit, person, VACATION } from "../fakes/ports";

const company = (workingDays: number[]): CompanyDTO =>
  ({ id: COMPANY, name: "Acme", timezone: "UTC", workingDays, allowancePolicy: "annual_calendar_year" }) as CompanyDTO;
const input: CompanySettingsInput = { name: "Acme", timezone: "UTC", workingDays: [1, 2, 3, 4, 5, 6], allowancePolicy: "annual_calendar_year" };

/** The use case on leave's fakes, with organisation's settings step answering `change` (and recording each save). */
function withSettings(kit: LeaveKit, change: CompanyChange) {
  const saves: CompanySettingsInput[] = [];
  const deps: UpdateCompanySettingsDeps = {
    leave: kit.deps,
    unitOfWork: (companyId, work) =>
      kit.deps.unitOfWork(companyId, (store) =>
        work(
          {
            save: async (_actor, i) => {
              saves.push(i);
              if (change.changed) kit.directory.settings = { ...kit.directory.settings, workingDays: change.after.workingDays };
              return change;
            },
          },
          store,
        ),
      ),
  };
  return { deps, saves };
}

function booked(): { kit: LeaveKit; id: Promise<string> } {
  const kit = leaveKit();
  kit.directory.add(person(ANA, "Ana"), person(BOSS, "Boss", { role: "admin" }));
  const draft = { leaveTypeId: VACATION, startDate: "2026-11-09", endDate: "2026-11-14", dayPortion: "full" as const, note: null };
  return { kit, id: addLeaveFor(kit.deps, actorFor(kit.directory.people.get(BOSS)!), ANA, draft).then((r) => unwrap(r).id) };
}
const boss = (kit: LeaveKit) => actorFor(kit.directory.people.get(BOSS)!);

test("only an admin may change the company's settings", async () => {
  const { kit } = booked();
  const { deps, saves } = withSettings(kit, { before: company([1, 2, 3, 4, 5]), after: company([1, 2, 3, 4, 5]), changed: false });
  const r = await updateCompanySettings(deps, actorFor(kit.directory.people.get(ANA)!), input);
  assert.ok(!r.ok && r.error.code === "forbidden");
  assert.equal(saves.length, 0);
});

test("settings saved with the same working days recount nothing", async () => {
  const { kit, id } = booked();
  await id;
  const events = kit.outbox.events.length;
  const { deps, saves } = withSettings(kit, { before: company([1, 2, 3, 4, 5]), after: { ...company([1, 2, 3, 4, 5]), name: "Acme Ltd" }, changed: true });
  const r = unwrap(await updateCompanySettings(deps, boss(kit), input));
  assert.equal(saves.length, 1);
  assert.equal(r.company.name, "Acme Ltd");
  assert.deepEqual(r.recount, NOTHING_RECOUNTED);
  assert.equal(kit.outbox.events.length, events);
});

test("new working days recount leave in the same unit of work and email the requester after it", async () => {
  const { kit, id: pending } = booked();
  const id = await pending;
  kit.sent.length = 0;
  const { deps } = withSettings(kit, { before: company([1, 2, 3, 4, 5]), after: company([1, 2, 3, 4, 5, 6]), changed: true });
  const r = unwrap(await updateCompanySettings(deps, boss(kit), input));
  assert.deepEqual(r.recount, { recounted: 1, nowFree: 0, overdrawn: [] });
  assert.equal(kit.requests.rows.get(id)?.days, 6);
  assert.equal(kit.outbox.types().at(-1), "leave.recounted");
  assert.deepEqual(
    kit.sent.map((m) => [m.type, m.to]),
    [["leave.recounted", "ana@example.test"]],
  );
});
