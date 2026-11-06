import type { Metadata } from "next";
import { APPROVAL_MODES, readApprovalMode } from "@/domain/approval-rule";
import { ALLOWANCE_POLICY_LABELS, APPROVAL_MODE_LABELS, COMPANY_NAME_MAX_LENGTH, ISO_WEEKDAYS } from "@/domain/company-settings";
import { DELETION_GRACE_DAYS } from "@/domain/person-deletion";
import { getCompanySettings } from "@/server/services/admin-company";
import { AdminShell } from "@/app/admin/admin-shell";
import { requireAdminPage } from "@/app/_lib/page-context";
import { Card } from "@/components/ui/card";
import { CheckboxField, ChoiceChip, Fieldset, SelectField, TextField } from "@/components/ui/fields";
import { choiceCard } from "@/components/ui/styles";
import { WEEKDAY_NAMES } from "@/lib/format";
import { ActionForm } from "@/components/forms/action-form";

import { updateCompanyAction } from "@/app/admin/company/actions";

export const metadata: Metadata = { title: "Company · Admin · OOOhm" };

export default async function CompanyPage() {
  const { actor, ctx, nav } = await requireAdminPage();
  const { company, timeZones, allowancePolicies } = await getCompanySettings(ctx, actor);
  const approvalMode = readApprovalMode(company.approvalMode);

  return (
    <AdminShell
      nav={nav}
      section="company"
      title="Company"
      description="Working days and the time zone decide how leave is counted and when a year starts. Changing the working days also recounts requests already sent, this year and later, and emails the people affected."
    >
      <Card aria-label="Company settings">
        <ActionForm action={updateCompanyAction} submitLabel="Save changes" pendingLabel="Saving…">
          <TextField label="Name" name="name" required maxLength={COMPANY_NAME_MAX_LENGTH} defaultValue={company.name} />
          <SelectField
            label="Time zone"
            name="timezone"
            defaultValue={company.timezone}
            options={timeZones.map((z) => ({ value: z, label: z.replaceAll("_", " ") }))}
            hint="Decides what “today” is and when each year begins."
          />
          <Fieldset legend="Working days" hint="Other days are never counted as leave. Pick at least one.">
            <div className="flex flex-wrap gap-2">
              {ISO_WEEKDAYS.map((d) => (
                <ChoiceChip key={d} type="checkbox" name="workingDays" value={d} defaultChecked={company.workingDays.includes(d)}>
                  {WEEKDAY_NAMES[d - 1]}
                </ChoiceChip>
              ))}
            </div>
          </Fieldset>
          <SelectField
            label="Allowance policy"
            name="allowancePolicy"
            defaultValue={company.allowancePolicy}
            options={allowancePolicies.map((p) => ({ value: p, label: ALLOWANCE_POLICY_LABELS[p] ?? p }))}
          />
          <Fieldset
            legend="Time off approval"
            className="space-y-3"
            hint="Balances apply either way. A change affects time off sent from now on; requests already waiting stay with their approver."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              {APPROVAL_MODES.map((mode) => (
                <label key={mode} className={choiceCard}>
                  <input type="radio" name="approvalMode" value={mode} defaultChecked={approvalMode === mode} className="mt-1 accent-[var(--accent)]" />
                  <span>
                    <span className="block text-sm font-medium">{APPROVAL_MODE_LABELS[mode].label}</span>
                    <span className="block text-xs text-muted">{APPROVAL_MODE_LABELS[mode].description}</span>
                  </span>
                </label>
              ))}
            </div>
          </Fieldset>
          <CheckboxField
            label={`Wait ${DELETION_GRACE_DAYS} days before a full scrub, with undo`}
            name="deletionGrace"
            defaultChecked={company.deletionGrace}
            hint="When you delete someone and remove everything about them, they're scheduled instead, and you can undo it until the day it runs. Deletes that keep records never wait."
          />
          <CheckboxField
            label="Managers can see their team's balances and notes"
            name="managersSeeDetails"
            defaultChecked={company.managersSeeDetails}
            hint="On a person's page (open it from Team), their manager sees what they have left and the notes on their requests. Turn it off and only the person and admins see those; everyone still sees who is off and when."
          />
        </ActionForm>
      </Card>
    </AdminShell>
  );
}
