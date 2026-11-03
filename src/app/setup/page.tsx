import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { COMPANY_NAME_MAX_LENGTH, supportedTimeZones } from "@/domain/company-settings";
import { PERSON_NAME_MAX_LENGTH } from "@/domain/people";
import { env } from "@/lib/env";
import { serviceContext } from "@/server/runtime";
import { isSetupOpen } from "@/server/services/install";
import { ActionForm } from "@/components/forms/action-form";
import { Logo } from "@/components/layout/logo";
import { Card } from "@/components/ui/card";
import { SelectField, TextField } from "@/components/ui/fields";
import { runSetupAction } from "./actions";

// Nobody should find this page through a search engine or a Referer header. The title is
// generic because it also heads the not-found page served once setup is closed.
export const metadata: Metadata = { title: "OOOhm", robots: { index: false, follow: false }, referrer: "no-referrer" };

/** The company's starting zone, as on a new company row; the admin can change it later. */
const DEFAULT_TIME_ZONE = "America/Chicago";

/**
 * First-time setup of a brand-new install: the company and its first admin. A 404
 * unless `SETUP_TOKEN` is set and nothing is set up yet, so it is gone for good once used.
 */
export default async function SetupPage() {
  // Read the database and the env per request, never at build time.
  await connection();
  if (!(await isSetupOpen(serviceContext(), env.SETUP_TOKEN))) notFound();
  const zones = [...supportedTimeZones()].sort();

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <Card as="div" padding="lg" className="w-full max-w-md space-y-6">
        <div className="space-y-2">
          <Logo className="text-2xl" />
          <h1 className="text-xl font-semibold tracking-tight">Set up OOOhm</h1>
          <p className="text-sm text-muted">
            Create your company and its first admin. This works once: afterwards this page is gone, and people join by invitation.
          </p>
        </div>
        <ActionForm action={runSetupAction} submitLabel="Set up OOOhm" pendingLabel="Setting up…">
          <TextField
            label="Setup token"
            name="token"
            type="password"
            autoComplete="off"
            required
            hint="The SETUP_TOKEN set for this deployment."
          />
          <TextField label="Company name" name="companyName" required maxLength={COMPANY_NAME_MAX_LENGTH} />
          <SelectField
            label="Time zone"
            name="timezone"
            defaultValue={DEFAULT_TIME_ZONE}
            options={zones.map((z) => ({ value: z, label: z.replaceAll("_", " ") }))}
            hint="Decides when each day starts. You can change it later."
          />
          <TextField label="Your name" name="adminName" required maxLength={PERSON_NAME_MAX_LENGTH} autoComplete="name" />
          <TextField
            label="Your work email"
            name="adminEmail"
            type="email"
            required
            autoComplete="email"
            hint="You'll sign in with this. A sign-in link goes here next."
          />
        </ActionForm>
      </Card>
    </main>
  );
}
