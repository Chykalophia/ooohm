import Link from "next/link";
import type { Metadata } from "next";
import { canAdminister } from "@/domain/admin-permissions";
import { PERSON_NAME_MAX_LENGTH } from "@/domain/people";
import { requireActor } from "@/lib/auth";
import { serviceContext } from "@/server/runtime";
import { getAccount } from "@/server/services/account";
import { getApprovalNav } from "@/server/services/approvals";
import { AdminForm } from "@/app/admin/forms";
import { TextField } from "@/app/admin/fields";
import { AppHeader } from "@/app/app-header";
import { NoCompany } from "@/app/no-company";
import { card, textLink } from "@/app/styles";
import { renameSelfAction } from "./actions";

export const metadata: Metadata = { title: "Your account · OOOhm" };

const ROLE_LABEL = { employee: "Employee", manager: "Manager", admin: "Admin" } as const;

/** The signed-in person's settings: their name to change, the rest to read. */
export default async function AccountPage() {
  const { user, actor } = await requireActor();
  const userName = user.name || user.email;
  if (!actor) return <NoCompany userName={userName} current="account" />;

  const ctx = serviceContext();
  const [account, approvals] = await Promise.all([getAccount(ctx, actor), getApprovalNav(ctx, actor)]);
  const details: [string, string][] = [
    ["Email", account.email],
    ["Role", ROLE_LABEL[account.role]],
    ["Department", account.department ?? "None"],
    ["Manager", account.manager ?? "None"],
  ];

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">
      <AppHeader userName={userName} approvals={approvals} current="account" admin={canAdminister(actor)} />

      <main className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Your account</h1>

        <section aria-labelledby="name-heading" className={`${card} space-y-4`}>
          <h2 id="name-heading" className="text-lg font-semibold tracking-tight">
            Your name
          </h2>
          <AdminForm action={renameSelfAction} submitLabel="Save" pendingLabel="Saving…">
            <TextField
              label="Name"
              name="name"
              defaultValue={account.name}
              required
              maxLength={PERSON_NAME_MAX_LENGTH}
              autoComplete="name"
              hint="How you appear to your team, on the calendar and in emails."
            />
          </AdminForm>
        </section>

        <section aria-labelledby="details-heading" className={`${card} space-y-3`}>
          <h2 id="details-heading" className="text-lg font-semibold tracking-tight">
            Details
          </h2>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[8rem_1fr]">
            {details.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted">{label}</dt>
                <dd className="break-words">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-sm text-muted">An admin changes these. Your email is how you sign in.</p>
        </section>

        <p className="text-sm">
          <Link href="/calendar/subscriptions" className={textLink}>
            Calendar subscriptions
          </Link>
          <span className="text-muted">: see your time off and the team&apos;s in Google, Apple or Outlook.</span>
        </p>
      </main>
    </div>
  );
}
