import type { Metadata } from "next";
import { ALLOWANCE_POLICY_LABELS, COMPANY_NAME_MAX_LENGTH, ISO_WEEKDAYS } from "@/domain/company-settings";
import { getCompanySettings } from "@/server/services/admin-company";
import { AdminShell, requireAdminPage } from "@/app/admin/admin-shell";
import { SelectField, TextField } from "@/app/admin/fields";
import { AdminForm } from "@/app/admin/forms";
import { card } from "@/app/admin/styles";
import { updateCompanyAction } from "@/app/admin/company/actions";

export const metadata: Metadata = { title: "Company · Admin · OOOhm" };

const WEEKDAY_LABEL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export default async function CompanyPage() {
  const { actor, ctx, userName, approvals } = await requireAdminPage();
  const { company, timeZones, allowancePolicies } = await getCompanySettings(ctx, actor);

  return (
    <AdminShell
      userName={userName}
      approvals={approvals}
      section="company"
      title="Company"
      description="Working days and the time zone decide how leave is counted and when a year starts. Changes apply to requests from now on; requests already sent keep their days."
    >
      <section aria-label="Company settings" className={card}>
        <AdminForm action={updateCompanyAction} submitLabel="Save changes" pendingLabel="Saving…">
          <TextField label="Name" name="name" required maxLength={COMPANY_NAME_MAX_LENGTH} defaultValue={company.name} />
          <SelectField
            label="Time zone"
            name="timezone"
            defaultValue={company.timezone}
            options={timeZones.map((z) => ({ value: z, label: z.replaceAll("_", " ") }))}
            hint="Decides what “today” is and when each year begins."
          />
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Working days</legend>
            <div className="flex flex-wrap gap-2">
              {ISO_WEEKDAYS.map((d) => (
                <label
                  key={d}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm has-[:checked]:border-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/40"
                >
                  <input
                    type="checkbox"
                    name="workingDays"
                    value={d}
                    defaultChecked={company.workingDays.includes(d)}
                    className="accent-[var(--accent)]"
                  />
                  {WEEKDAY_LABEL[d - 1]}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted">Other days are never counted as leave. Pick at least one.</p>
          </fieldset>
          <SelectField
            label="Allowance policy"
            name="allowancePolicy"
            defaultValue={company.allowancePolicy}
            options={allowancePolicies.map((p) => ({ value: p, label: ALLOWANCE_POLICY_LABELS[p] ?? p }))}
          />
        </AdminForm>
      </section>
    </AdminShell>
  );
}
