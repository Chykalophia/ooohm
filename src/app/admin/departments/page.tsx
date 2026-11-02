import type { Metadata } from "next";
import { DEPARTMENT_NAME_MAX_LENGTH } from "@/domain/people";
import { formatCount } from "@/lib/format";
import { listDepartmentsForAdmin } from "@/server/services/admin-departments";
import { AdminShell } from "@/app/admin/admin-shell";
import { requireAdminPage } from "@/app/_lib/page-context";
import { Card, Item, ItemList } from "@/components/ui/card";
import { TextField } from "@/components/ui/fields";
import { ActionForm } from "@/components/forms/action-form";
import { InlineAction } from "@/components/forms/inline-action";
import { Reveal } from "@/components/forms/reveal";
import { outlineButton } from "@/components/ui/styles";
import { createDepartmentAction, deleteDepartmentAction, renameDepartmentAction } from "@/app/admin/departments/actions";

export const metadata: Metadata = { title: "Departments · Admin · OOOhm" };

export default async function DepartmentsPage() {
  const { actor, ctx, nav } = await requireAdminPage();
  const departments = await listDepartmentsForAdmin(ctx, actor);

  return (
    <AdminShell
      nav={nav}
      section="departments"
      title="Departments"
      description="Group people so the team view can show one department at a time. Approvals follow each person's manager, not their department."
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
              <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
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
