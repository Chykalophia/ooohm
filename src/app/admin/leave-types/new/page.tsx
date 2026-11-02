import type { Metadata } from "next";
import Link from "next/link";
import { AdminShell, requireAdminPage } from "@/app/admin/admin-shell";
import { AdminForm } from "@/app/admin/forms";
import { card, subtleButton } from "@/app/admin/styles";
import { createLeaveTypeAction } from "@/app/admin/leave-types/actions";
import { LeaveTypeFields } from "@/app/admin/leave-types/leave-type-fields";

export const metadata: Metadata = { title: "Add leave type · Admin · OOOhm" };

export default async function NewLeaveTypePage() {
  const { userName, approvals } = await requireAdminPage();
  return (
    <AdminShell userName={userName} approvals={approvals} section="leave-types" title="Add leave type">
      <section aria-label="Leave type" className={card}>
        <AdminForm action={createLeaveTypeAction} submitLabel="Add leave type" pendingLabel="Adding…" resetOnSuccess>
          <LeaveTypeFields />
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
