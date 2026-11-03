import type { Metadata } from "next";
import { EMAIL_MAX_LENGTH } from "@/domain/people";
import { getPersonFormOptions } from "@/server/services/admin-people";
import { AdminShell } from "@/app/admin/admin-shell";
import { requireAdminPage } from "@/app/_lib/page-context";
import { BackLink } from "@/components/ui/section";
import { Card } from "@/components/ui/card";
import { TextField } from "@/components/ui/fields";
import { ActionForm } from "@/components/forms/action-form";
import { inviteAction } from "@/app/admin/people/actions";
import { PersonFields } from "@/app/admin/people/person-fields";

export const metadata: Metadata = { title: "Invite someone · Admin · OOOhm" };

export default async function InvitePage() {
  const { actor, ctx, nav } = await requireAdminPage();
  const { departments, managers } = await getPersonFormOptions(ctx, actor, null);

  return (
    <AdminShell
      nav={nav}
      section="people"
      title="Invite someone"
      description="They get an email with a sign-in link. The link lasts 15 minutes; after that they can ask for a new one on the sign-in page."
    >
      <Card aria-label="Invite">
        <ActionForm action={inviteAction} submitLabel="Send invite" pendingLabel="Sending…" resetOnSuccess>
          <TextField label="Email" name="email" type="email" required maxLength={EMAIL_MAX_LENGTH} autoComplete="off" />
          <PersonFields departments={departments} managers={managers} />
        </ActionForm>
      </Card>
      <BackLink href="/admin/people">Back to people</BackLink>
    </AdminShell>
  );
}
