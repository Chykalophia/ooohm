import type { Metadata } from "next";
import { AdminShell } from "@/app/admin/admin-shell";
import { requireAdminPage } from "@/app/_lib/page-context";
import { BackLink } from "@/components/ui/section";
import { Card } from "@/components/ui/card";
import { ActionForm } from "@/components/forms/action-form";
import { createLeaveTypeAction } from "@/app/admin/leave-types/actions";
import { LeaveTypeFields } from "@/app/admin/leave-types/leave-type-fields";

export const metadata: Metadata = { title: "Add leave type · Admin · OOOhm" };

export default async function NewLeaveTypePage() {
  const { nav } = await requireAdminPage();
  return (
    <AdminShell nav={nav} section="leave-types" title="Add leave type">
      <Card aria-label="Leave type">
        <ActionForm action={createLeaveTypeAction} submitLabel="Add leave type" pendingLabel="Adding…" resetOnSuccess>
          <LeaveTypeFields />
        </ActionForm>
      </Card>
      <BackLink href="/admin/leave-types">Back to leave types</BackLink>
    </AdminShell>
  );
}
