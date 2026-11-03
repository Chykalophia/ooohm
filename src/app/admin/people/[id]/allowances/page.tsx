import type { Metadata } from "next";
import { z } from "zod";
import { ALLOWANCE_YEAR_MAX, ALLOWANCE_YEAR_MIN, MAX_ALLOWANCE_DAYS } from "@/domain/leave-type-settings";
import { NOTE_MAX_LENGTH } from "@/domain/leave-request";
import { formatDays } from "@/lib/format";
import { getPersonDetail } from "@/server/services/admin-people";
import { ActionForm } from "@/components/forms/action-form";
import { Reveal } from "@/components/forms/reveal";
import { BalanceFigures, LeaveTypeName } from "@/components/leave/balance-list";
import { YearNav } from "@/components/navigation/year-nav";
import { Card } from "@/components/ui/card";
import { TextField } from "@/components/ui/fields";
import { BackLink } from "@/components/ui/section";
import { outlineButton } from "@/components/ui/styles";
import { orNotFound, requireAdminPage } from "@/app/_lib/page-context";
import { AdminShell } from "@/app/admin/admin-shell";
import { allowanceAction } from "@/app/admin/people/actions";

export const metadata: Metadata = { title: "Allowances · Admin · OOOhm" };

const yearSchema = z.coerce.number().int().min(ALLOWANCE_YEAR_MIN).max(ALLOWANCE_YEAR_MAX).optional().catch(undefined);

export default async function AllowancesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { actor, ctx, nav } = await requireAdminPage();
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const { person, year, firstEditableYear, balances, leaveTypes } = await orNotFound(getPersonDetail(ctx, actor, id, yearSchema.parse(query.year)));
  const name = person.name || person.email;
  const yearHref = (y: number) => `/admin/people/${person.id}/allowances?year=${y}`;
  const editable = year >= firstEditableYear;

  return (
    <AdminShell
      nav={nav}
      section="people"
      title={`Allowances for ${name}`}
      description="Set this person's allowance for a year, or add or take away days with a reason. Days carried over are set by the year rollover."
    >
      <YearNav year={year} min={ALLOWANCE_YEAR_MIN} max={ALLOWANCE_YEAR_MAX} href={yearHref} />
      {!editable && <p className="text-sm text-muted">{year} is closed: allowances can be changed from {firstEditableYear} on.</p>}

      {!balances ? (
        <p className="text-muted">Balances aren&apos;t available: check the company&apos;s allowance policy.</p>
      ) : balances.items.length === 0 ? (
        <p className="text-muted">No active leave types.</p>
      ) : (
        <ul className="space-y-4">
          {balances.items.map(({ leaveTypeId, name: typeName, color, archived, balance, row }) => {
            const settings = leaveTypes.get(leaveTypeId);
            const days = row?.days ?? (balance.tracked ? balance.allowance : (settings?.defaultAllowanceDays ?? ""));
            return (
              <Card as="li" key={leaveTypeId} className="space-y-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <LeaveTypeName name={typeName} color={color} archived={archived} as="h3" />
                  <BalanceFigures balance={balance} year={year} />
                </div>
                {!editable ? null : settings && !settings.countsAgainstAllowance ? (
                  <p className="text-sm text-muted">This leave type doesn&apos;t count against an allowance, so there&apos;s nothing to set.</p>
                ) : (
                  <Reveal label="Change" ariaLabel={`Change ${typeName} allowance`}>
                    <ActionForm action={allowanceAction} submitLabel="Save" pendingLabel="Saving…" buttonClassName={outlineButton} resetOnSuccess>
                      <input type="hidden" name="userId" value={person.id} />
                      <input type="hidden" name="leaveTypeId" value={leaveTypeId} />
                      <input type="hidden" name="year" value={year} />
                      <div className="grid gap-4 sm:grid-cols-2">
                        <TextField
                          label={`Allowance for ${year}`}
                          name="days"
                          type="number"
                          inputMode="decimal"
                          required
                          min={0}
                          max={MAX_ALLOWANCE_DAYS}
                          step={0.1}
                          defaultValue={days}
                          hint={row ? "This person's own allowance." : `Now the leave type's default${settings?.defaultAllowanceDays == null ? " (none)" : ""}.`}
                        />
                        <TextField
                          label="Adjustment"
                          name="adjustmentDays"
                          type="number"
                          inputMode="decimal"
                          required
                          min={-MAX_ALLOWANCE_DAYS}
                          max={MAX_ALLOWANCE_DAYS}
                          step={0.1}
                          defaultValue={row?.adjustmentDays ?? 0}
                          hint="Days added (or taken away, with a minus) on top."
                        />
                      </div>
                      {row && row.carriedOverDays !== 0 && (
                        <p className="text-sm text-muted">
                          {formatDays(row.carriedOverDays)} carried over from {year - 1} stay as they are.
                        </p>
                      )}
                      <TextField label="Reason" name="reason" required maxLength={NOTE_MAX_LENGTH} hint="Kept in the audit log." />
                      <p className="text-sm text-muted">
                        Setting less than is already booked is allowed; the balance then shows how many days over it is.
                      </p>
                    </ActionForm>
                  </Reveal>
                )}
              </Card>
            );
          })}
        </ul>
      )}

      <BackLink href={`/admin/people/${person.id}`}>Back to {name}</BackLink>
    </AdminShell>
  );
}
