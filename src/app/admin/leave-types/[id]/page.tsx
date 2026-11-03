import type { Metadata } from "next";
import { getLeaveTypeForAdmin } from "@/server/services/admin-leave-types";
import { AdminShell } from "@/app/admin/admin-shell";
import { orNotFound, requireAdminPage } from "@/app/_lib/page-context";
import { BackLink } from "@/components/ui/section";
import { Card } from "@/components/ui/card";
import { ActionForm } from "@/components/forms/action-form";
import { updateLeaveTypeAction } from "@/app/admin/leave-types/actions";
import { LeaveTypeFields } from "@/app/admin/leave-types/leave-type-fields";

export const metadata: Metadata = { title: "Leave type · Admin · OOOhm" };

export default async function EditLeaveTypePage({ params }: { params: Promise<{ id: string }> }) {
  const { actor, ctx, nav } = await requireAdminPage();
  const { id } = await params;
  const leaveType = await orNotFound(getLeaveTypeForAdmin(ctx, actor, id));

  return (
    <AdminShell
      nav={nav}
      section="leave-types"
      title={leaveType.name}
      description={leaveType.archivedAt ? "Archived: not in the request form. Restore it from the list." : undefined}
    >
      <Card aria-label="Leave type">
        <ActionForm action={updateLeaveTypeAction} submitLabel="Save changes" pendingLabel="Saving…">
          <input type="hidden" name="id" value={leaveType.id} />
          <LeaveTypeFields leaveType={leaveType} />
        </ActionForm>
      </Card>
      <BackLink href="/admin/leave-types">Back to leave types</BackLink>
    </AdminShell>
  );
}
