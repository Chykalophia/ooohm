import type { Metadata } from "next";
import Link from "next/link";
import { EMAIL_MAX_LENGTH } from "@/domain/people";
import { getPersonFormOptions } from "@/server/services/admin-people";
import { AdminShell, requireAdminPage } from "@/app/admin/admin-shell";
import { TextField } from "@/app/admin/fields";
import { AdminForm } from "@/app/admin/forms";
import { card, subtleButton } from "@/app/styles";
import { inviteAction } from "@/app/admin/people/actions";
import { PersonFields } from "@/app/admin/people/person-fields";

export const metadata: Metadata = { title: "Invite someone · Admin · OOOhm" };

export default async function InvitePage() {
  const { actor, ctx, userName, approvals } = await requireAdminPage();
  const { departments, managers } = await getPersonFormOptions(ctx, actor, null);

  return (
    <AdminShell
      userName={userName}
      approvals={approvals}
      section="people"
      title="Invite someone"
      description="They get an email with a sign-in link. The link lasts 15 minutes; after that they can ask for a new one on the sign-in page."
    >
      <section aria-label="Invite" className={card}>
        <AdminForm action={inviteAction} submitLabel="Send invite" pendingLabel="Sending…" resetOnSuccess>
          <TextField label="Email" name="email" type="email" required maxLength={EMAIL_MAX_LENGTH} autoComplete="off" />
          <PersonFields departments={departments} managers={managers} />
        </AdminForm>
      </section>
      <p>
        <Link href="/admin/people" className={subtleButton}>
          Back to people
        </Link>
      </p>
    </AdminShell>
  );
}
