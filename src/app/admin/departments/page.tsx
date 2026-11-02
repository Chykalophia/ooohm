import type { Metadata } from "next";
import { DEPARTMENT_NAME_MAX_LENGTH } from "@/domain/people";
import { listDepartmentsForAdmin } from "@/server/services/admin-departments";
import { AdminShell, requireAdminPage } from "@/app/admin/admin-shell";
import { TextField } from "@/app/admin/fields";
import { AdminForm, InlineAction, Reveal } from "@/app/admin/forms";
import { card, outlineButton } from "@/app/styles";
import { createDepartmentAction, deleteDepartmentAction, renameDepartmentAction } from "@/app/admin/departments/actions";

export const metadata: Metadata = { title: "Departments · Admin · OOOhm" };

export default async function DepartmentsPage() {
  const { actor, ctx, userName, approvals } = await requireAdminPage();
  const departments = await listDepartmentsForAdmin(ctx, actor);

  return (
    <AdminShell
      userName={userName}
      approvals={approvals}
      section="departments"
      title="Departments"
      description="Group people so the team view can show one department at a time. Approvals follow each person's manager, not their department."
    >
      <section aria-label="Add a department" className={card}>
        <AdminForm action={createDepartmentAction} submitLabel="Add department" pendingLabel="Adding…" resetOnSuccess className="space-y-4">
          <TextField label="Name" name="name" required maxLength={DEPARTMENT_NAME_MAX_LENGTH} autoComplete="off" />
        </AdminForm>
      </section>

      {departments.length === 0 ? (
        <p className="text-muted">No departments yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
          {departments.map((d) => (
            <li key={d.id} className="space-y-3 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium break-words">{d.name}</p>
                <p className="text-sm text-muted">
                  {d.members === 0 ? "Nobody" : d.members === 1 ? "1 person" : `${d.members} people`}
                </p>
              </div>
              <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
                <Reveal label="Rename" ariaLabel={`Rename ${d.name}`}>
                  <AdminForm action={renameDepartmentAction} submitLabel="Save" pendingLabel="Saving…" buttonClassName={outlineButton} className="space-y-3">
                    <input type="hidden" name="id" value={d.id} />
                    <TextField label={`New name for ${d.name}`} name="name" required maxLength={DEPARTMENT_NAME_MAX_LENGTH} defaultValue={d.name} />
                  </AdminForm>
                </Reveal>
                {d.members === 0 ? (
                  <InlineAction
                    action={deleteDepartmentAction}
                    fields={{ id: d.id }}
                    label="Delete"
                    ariaLabel={`Delete ${d.name}`}
                    pendingLabel="Deleting…"
                    danger
                    confirm={`Delete ${d.name}?`}
                    confirmLabel="Yes, delete"
                  />
                ) : (
                  <p className="text-sm text-muted">To delete it, move its people to another department first.</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </AdminShell>
  );
}
