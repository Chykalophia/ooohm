import type { Metadata } from "next";
import { PEOPLE_IMPORT_MAX_ROWS } from "@/domain/people-import";
import { AdminShell } from "@/app/admin/admin-shell";
import { requireAdminPage } from "@/app/_lib/page-context";
import { BackLink } from "@/components/ui/section";
import { Card } from "@/components/ui/card";
import { cx, textLink } from "@/components/ui/styles";
import { peopleImportAction } from "./actions";
import { ImportForm } from "./import-form";

export const metadata: Metadata = { title: "Import people · Admin · OOOhm" };

export default async function ImportPeoplePage() {
  const { nav } = await requireAdminPage();

  return (
    <AdminShell
      nav={nav}
      section="people"
      title="Import people"
      description={`Add up to ${PEOPLE_IMPORT_MAX_ROWS} people at once from a spreadsheet saved as CSV. Nothing changes until you've seen what the file will do.`}
    >
      <Card aria-label="Import people" className="space-y-6">
        <div className="space-y-2 text-sm">
          <p>
            Start from the{" "}
            <a href="/admin/people/import/sample" download className={cx(textLink, "font-medium text-accent-ink")}>
              sample CSV file
            </a>
            . Each row is one person. Only <span className="font-medium">email</span> and <span className="font-medium">name</span> are
            required.
          </p>
          <ul className="list-disc space-y-1 pl-5 text-muted">
            <li>role is employee, manager or admin (employee if blank).</li>
            <li>department is created if you don&apos;t have it yet.</li>
            <li>manager_email can be someone already here or someone else in the file.</li>
            <li>can_self_approve is yes or no (no if blank).</li>
          </ul>
          <p className="text-muted">People who already have an account are left as is, so you can upload the same file again after fixing it.</p>
        </div>
        <ImportForm action={peopleImportAction} />
      </Card>
      <BackLink href="/admin/people">Back to people</BackLink>
    </AdminShell>
  );
}
