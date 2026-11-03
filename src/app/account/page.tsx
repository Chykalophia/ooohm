import Link from "next/link";
import type { Metadata } from "next";
import { PERSON_NAME_MAX_LENGTH } from "@/domain/people";
import { THEMES, type Theme } from "@/domain/theme";
import { ROLE_LABEL } from "@/lib/format";
import { getAccount } from "@/server/services/account";
import { ActionForm } from "@/components/forms/action-form";
import { AppPage } from "@/components/layout/app-page";
import { NoCompany } from "@/components/layout/no-company";
import { ChoiceChip, Fieldset, TextField } from "@/components/ui/fields";
import { Section } from "@/components/ui/section";
import { textLink } from "@/components/ui/styles";
import { requireMemberPage } from "@/app/_lib/page-context";
import { renameSelfAction, setThemeAction } from "./actions";

export const metadata: Metadata = { title: "Your account · OOOhm" };

const THEME_LABEL: Record<Theme, string> = { light: "Light", dark: "Dark", system: "Automatic" };

/** The signed-in person's settings: their name and theme to change, the rest to read. */
export default async function AccountPage() {
  const page = await requireMemberPage();
  if (!page.actor) return <NoCompany nav={page.nav} current="account" />;

  const account = await getAccount(page.ctx, page.actor);
  const details: [string, string][] = [
    ["Email", account.email],
    ["Role", ROLE_LABEL[account.role]],
    ["Department", account.department ?? "None"],
    ["Manager", account.manager ?? "None"],
  ];

  return (
    <AppPage nav={page.nav} current="account" title="Your account">
      <Section title="Your name" surface>
        <ActionForm action={renameSelfAction} submitLabel="Save" pendingLabel="Saving…">
          <TextField
            label="Name"
            name="name"
            defaultValue={account.name}
            required
            maxLength={PERSON_NAME_MAX_LENGTH}
            autoComplete="name"
            hint="How you appear to your team, on the calendar and in emails."
          />
        </ActionForm>
      </Section>

      <Section title="Appearance" surface>
        <ActionForm action={setThemeAction} submitLabel="Save" pendingLabel="Saving…">
          <Fieldset legend="Theme" hint="Automatic follows your device, switching between light and dark with it.">
            <div className="flex flex-wrap gap-2">
              {THEMES.map((theme) => (
                <ChoiceChip key={theme} type="radio" name="theme" value={theme} defaultChecked={theme === page.theme} required>
                  {THEME_LABEL[theme]}
                </ChoiceChip>
              ))}
            </div>
          </Fieldset>
        </ActionForm>
      </Section>

      <Section title="Details" surface className="space-y-3">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[8rem_1fr]">
          {details.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted">{label}</dt>
              <dd className="break-words">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-sm text-muted">An admin changes these. Your email is how you sign in.</p>
      </Section>

      <p className="text-sm">
        <Link href="/calendar/subscriptions" className={textLink}>
          Calendar subscriptions
        </Link>
        <span className="text-muted">: see your time off and the team&apos;s in Google, Apple or Outlook.</span>
      </p>
    </AppPage>
  );
}
