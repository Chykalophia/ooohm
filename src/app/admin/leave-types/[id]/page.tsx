import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isDomainError } from "@/domain/errors";
import { getLeaveTypeForAdmin } from "@/server/services/admin-leave-types";
import { AdminShell, requireAdminPage } from "@/app/admin/admin-shell";
import { AdminForm } from "@/app/admin/forms";
import { card, subtleButton } from "@/app/admin/styles";
import { updateLeaveTypeAction } from "@/app/admin/leave-types/actions";
import { LeaveTypeFields } from "@/app/admin/leave-types/leave-type-fields";

export const metadata: Metadata = { title: "Leave type · Admin · OOOhm" };

export default async function EditLeaveTypePage({ params }: { params: Promise<{ id: string }> }) {
  const { actor, ctx, userName, approvals } = await requireAdminPage();
  const { id } = await params;
  const leaveType = await getLeaveTypeForAdmin(ctx, actor, id).catch((err: unknown) => {
    if (isDomainError(err, "not_found")) notFound();
    throw err;
  });

  return (
    <AdminShell
      userName={userName}
      approvals={approvals}
      section="leave-types"
      title={leaveType.name}
      description={leaveType.archivedAt ? "Archived: not in the request form. Restore it from the list." : undefined}
    >
      <section aria-label="Leave type" className={card}>
        <AdminForm action={updateLeaveTypeAction} submitLabel="Save changes" pendingLabel="Saving…">
          <input type="hidden" name="id" value={leaveType.id} />
          <LeaveTypeFields leaveType={leaveType} />
        </AdminForm>
      </section>
      <p>
        <Link href="/admin/leave-types" className={subtleButton}>
          Back to leave types
        </Link>
      </p>
    </AdminShell>
  );
}
