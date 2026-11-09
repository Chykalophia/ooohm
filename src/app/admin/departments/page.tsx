import type { Metadata } from "next";
import { MAX_OFF_LIMIT } from "@/domain/coverage";
import { DEPARTMENT_NAME_MAX_LENGTH } from "@/domain/people";
import { formatCount } from "@/lib/format";
import { listDepartmentManagerChoices, listDepartmentsForAdmin } from "@/server/services/admin-departments";
import { AdminShell } from "@/app/admin/admin-shell";
import { requireAdminPage } from "@/app/_lib/page-context";
import { Card, Item, ItemList } from "@/components/ui/card";
import { SelectField, TextField } from "@/components/ui/fields";
import { ActionForm } from "@/components/forms/action-form";
import { InlineAction } from "@/components/forms/inline-action";
import { Reveal } from "@/components/forms/reveal";
import { outlineButton } from "@/components/ui/styles";
import {
  createDepartmentAction,
  deleteDepartmentAction,
  renameDepartmentAction,
  setDepartmentLimitAction,
  setDepartmentManagerAction,
} from "@/app/admin/departments/actions";

export const metadata: Metadata = { title: "Departments · Admin · OOOhm" };

export default async function DepartmentsPage() {
  const { actor, ctx, nav } = await requireAdminPage();
  const [departments, people] = await Promise.all([listDepartmentsForAdmin(ctx, actor), listDepartmentManagerChoices(ctx, actor)]);
  const managerOptions = [{ value: "", label: "No department manager" }, ...people.map((p) => ({ value: p.id, label: p.label }))];

  return (
    <AdminShell
      nav={nav}
      section="departments"
      title="Departments"
      description="Group people so the team view can show one department at a time. A department can have a manager, who approves for its people that have no manager of their own, and a limit on how many of its people are off at once."
    >
      <Card aria-label="Add a department">
        <ActionForm action={createDepartmentAction} submitLabel="Add department" pendingLabel="Adding…" resetOnSuccess className="space-y-4">
          <TextField label="Name" name="name" required maxLength={DEPARTMENT_NAME_MAX_LENGTH} autoComplete="off" />
        </ActionForm>
      </Card>

      {departments.length === 0 ? (
        <p className="text-muted">No departments yet.</p>
      ) : (
        <ItemList>
          {departments.map((d) => (
            <Item key={d.id} className="space-y-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium break-words">{d.name}</p>
                <p className="text-sm text-muted">
                  {d.members === 0 ? "Nobody" : formatCount(d.members, "person", "people")}
                </p>
              </div>
              <p className="text-sm text-muted">
                {d.managerName ? `Managed by ${d.managerName}` : "No department manager"}
                {d.maxOff !== null && ` · A warning past ${formatCount(d.maxOff, "person", "people")} off at once`}
              </p>
              <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
                <Reveal label={d.managerId ? "Change manager" : "Set a manager"} ariaLabel={`Change the manager of ${d.name}`}>
                  <ActionForm
                    action={setDepartmentManagerAction}
                    submitLabel="Save"
                    pendingLabel="Saving…"
                    buttonClassName={outlineButton}
                    className="space-y-3"
                  >
                    <input type="hidden" name="id" value={d.id} />
                    <SelectField
                      label={`Manager of ${d.name}`}
                      name="managerId"
                      optional
                      defaultValue={d.managerId ?? ""}
                      options={
                        d.managerId && !people.some((p) => p.id === d.managerId)
                          ? [...managerOptions, { value: d.managerId, label: `${d.managerName} (deactivated)` }]
                          : managerOptions
                      }
                      hint="Approves for people here who have no active manager of their own. Sees their balances and notes like a manager, when the company lets managers see them."
                    />
                  </ActionForm>
                </Reveal>
                <Reveal label={d.maxOff === null ? "Set a limit" : "Change limit"} ariaLabel={`Change how many people of ${d.name} can be off at once`}>
                  <ActionForm action={setDepartmentLimitAction} submitLabel="Save" pendingLabel="Saving…" buttonClassName={outlineButton} className="space-y-3">
                    <input type="hidden" name="id" value={d.id} />
                    <TextField
                      label={`Most people of ${d.name} off at once`}
                      name="maxOff"
                      type="number"
                      inputMode="numeric"
                      optional
                      min={1}
                      max={MAX_OFF_LIMIT}
                      step={1}
                      defaultValue={d.maxOff ?? ""}
                      hint="Past this, the person asking and their approver see a warning. Nothing is blocked. Leave it blank for no limit."
                    />
                  </ActionForm>
                </Reveal>
                <Reveal label="Rename" ariaLabel={`Rename ${d.name}`}>
                  <ActionForm action={renameDepartmentAction} submitLabel="Save" pendingLabel="Saving…" buttonClassName={outlineButton} className="space-y-3">
                    <input type="hidden" name="id" value={d.id} />
                    <TextField label={`New name for ${d.name}`} name="name" required maxLength={DEPARTMENT_NAME_MAX_LENGTH} defaultValue={d.name} />
                  </ActionForm>
                </Reveal>
                {d.members === 0 ? (
                  <InlineAction
                    action={deleteDepartmentAction}
                    fields={{ id: d.id }}
                    label="Delete"
                    ariaLabel={`Delete ${d.name}`}
                    pendingLabel="Deleting…"
                    variant="danger"
                    confirm={`Delete ${d.name}?`}
                    confirmLabel="Yes, delete"
                  />
                ) : (
                  <p className="text-sm text-muted">To delete it, move its people to another department first.</p>
                )}
              </div>
            </Item>
          ))}
        </ItemList>
      )}
    </AdminShell>
  );
}
