import Link from "next/link";
import type { Metadata } from "next";
import { PERSON_NAME_MAX_LENGTH } from "@/domain/people";
import { followsDarkMode, THEMES } from "@/domain/appearance";
import { COLOR_MODES, type ColorMode } from "@/domain/color-mode";
import { formatInstantDate, ROLE_LABEL } from "@/lib/format";
import { getAccount } from "@/server/services/account";
import { ActionForm } from "@/components/forms/action-form";
import { AppPage } from "@/components/layout/app-page";
import { NoCompany } from "@/components/layout/no-company";
import { ChoiceChip, Fieldset, TextField } from "@/components/ui/fields";
import { Section } from "@/components/ui/section";
import { textLink } from "@/components/ui/styles";
import { requestAppearance } from "@/app/_lib/appearance";
import { requireMemberPage } from "@/app/_lib/page-context";
import { renameSelfAction, setColorModeAction } from "./actions";
import { Passkeys } from "./passkeys";

export const metadata: Metadata = { title: "Your account · OOOhm" };

const COLOR_MODE_LABEL: Record<ColorMode, string> = { light: "Light", dark: "Dark", system: "Automatic" };

/** The signed-in person's settings: their name and colour mode to change, the rest to read. */
export default async function AccountPage() {
  const page = await requireMemberPage();
  if (!page.actor) return <NoCompany nav={page.nav} current="account" />;

  const [account, appearance] = await Promise.all([getAccount(page.ctx, page.actor), requestAppearance()]);
  // Only some company themes have a dark version; on the others, pages stay light.
  const darkAvailable = followsDarkMode(appearance);
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

      <Section title="Light or dark" surface>
        <ActionForm action={setColorModeAction} submitLabel="Save" pendingLabel="Saving…">
          <Fieldset
            legend="Mode"
            hint={
              darkAvailable
                ? "Automatic follows your device, switching between light and dark with it."
                : `Your company's theme, ${THEMES[appearance.theme].label}, comes in light only, so pages stay light for now. Your choice applies if an admin picks a theme with a dark version.`
            }
          >
            <div className="flex flex-wrap gap-2">
              {COLOR_MODES.map((mode) => (
                <ChoiceChip key={mode} type="radio" name="colorMode" value={mode} defaultChecked={mode === page.colorMode} required>
                  {COLOR_MODE_LABEL[mode]}
                </ChoiceChip>
              ))}
            </div>
          </Fieldset>
        </ActionForm>
      </Section>

      <Section id="passkeys" title="Passkeys" surface className="scroll-mt-6 space-y-4">
        <Passkeys
          passkeys={account.passkeys.map((p) => ({
            id: p.id,
            name: p.name,
            synced: p.synced,
            added: p.createdAt ? formatInstantDate(p.createdAt, account.timezone) : null,
          }))}
        />
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
