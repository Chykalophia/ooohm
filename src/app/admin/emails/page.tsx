import type { Metadata } from "next";
import Link from "next/link";
import { listEmailsForAdmin } from "@/server/services/admin-emails";
import { AdminShell } from "@/app/admin/admin-shell";
import { requireAdminPage } from "@/app/_lib/page-context";
import { Item, ItemList } from "@/components/ui/card";
import { cx, textLink } from "@/components/ui/styles";

export const metadata: Metadata = { title: "Emails · Admin · OOOhm" };

export default async function EmailsPage() {
  const { actor, ctx, nav } = await requireAdminPage();
  const emails = await listEmailsForAdmin(ctx, actor);

  return (
    <AdminShell
      nav={nav}
      section="emails"
      title="Emails"
      description="The emails OOOhm sends for you. Change what one says, in your own words; the request's details, the buttons and the links stay as they are."
    >
      <ItemList aria-label="Emails">
        {emails.map((email) => (
          <Item key={email.type} className="flex flex-wrap items-start justify-between gap-x-6 gap-y-1">
            <div className="min-w-0 space-y-1">
              <p className="font-medium">
                <Link href={`/admin/emails/${email.type}`} className={cx(textLink, "break-words")}>
                  {email.label}
                </Link>
              </p>
              <p className="text-sm text-muted">{email.description}</p>
            </div>
            <p className="whitespace-nowrap text-sm text-muted">{email.customized ? "Your wording" : "OOOhm's wording"}</p>
          </Item>
        ))}
      </ItemList>
    </AdminShell>
  );
}
