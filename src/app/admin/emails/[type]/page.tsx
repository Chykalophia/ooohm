import type { Metadata } from "next";
import { getEmailForAdmin, previewEmail } from "@/server/services/admin-emails";
import { AdminShell } from "@/app/admin/admin-shell";
import { orNotFound, requireAdminPage } from "@/app/_lib/page-context";
import { BackLink } from "@/components/ui/section";
import { Card } from "@/components/ui/card";
import { InlineAction } from "@/components/forms/inline-action";
import { resetEmailCopyAction } from "@/app/admin/emails/actions";
import { EmailEditor } from "@/app/admin/emails/[type]/email-editor";

export const metadata: Metadata = { title: "Email · Admin · OOOhm" };

export default async function EditEmailPage({ params }: { params: Promise<{ type: string }> }) {
  const { actor, ctx, nav } = await requireAdminPage();
  const { type } = await params;
  const email = await orNotFound(getEmailForAdmin(ctx, actor, type));
  // The fields start from what goes out now: the saved words, else OOOhm's own.
  const initial = {
    subject: email.saved?.subject ?? email.defaults.subject,
    message: email.saved?.message ?? email.defaults.message,
  };
  const firstPreview = await previewEmail(ctx, actor, email.type, initial);

  return (
    <AdminShell nav={nav} section="emails" title={email.label} description={email.description}>
      <Card aria-label="Email wording">
        <EmailEditor
          type={email.type}
          initial={initial}
          variables={email.variables}
          firstPreview={{ subject: firstPreview.subject, html: firstPreview.html }}
        />
      </Card>
      {email.saved && (
        <InlineAction
          action={resetEmailCopyAction}
          fields={{ type: email.type }}
          label="Go back to OOOhm's wording"
          pendingLabel="Resetting…"
          variant="danger"
          confirm="Go back to OOOhm's own subject and message for this email? Your wording is removed."
          confirmLabel="Yes, go back"
        />
      )}
      <BackLink href="/admin/emails">Back to emails</BackLink>
    </AdminShell>
  );
}
