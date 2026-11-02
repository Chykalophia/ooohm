import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { isDomainError } from "@/domain/errors";
import { ALLOWANCE_YEAR_MAX, ALLOWANCE_YEAR_MIN, MAX_ALLOWANCE_DAYS } from "@/domain/leave-type-settings";
import { NOTE_MAX_LENGTH } from "@/domain/leave-request";
import { formatBalanceTotal, formatBalanceUsage, formatDays } from "@/lib/format";
import { getPersonDetail } from "@/server/services/admin-people";
import { AdminShell, requireAdminPage } from "@/app/admin/admin-shell";
import { YearNav } from "@/app/admin/year-nav";
import { TextField } from "@/app/admin/fields";
import { AdminForm, Reveal } from "@/app/admin/forms";
import { card, focusRing, outlineButton, subtleButton } from "@/app/styles";
import { allowanceAction } from "@/app/admin/people/actions";
import { remainingText } from "@/app/admin/people/balance-list";

export const metadata: Metadata = { title: "Allowances · Admin · OOOhm" };

const yearSchema = z.coerce.number().int().min(ALLOWANCE_YEAR_MIN).max(ALLOWANCE_YEAR_MAX).optional().catch(undefined);

export default async function AllowancesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { actor, ctx, userName, approvals } = await requireAdminPage();
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const { person, year, firstEditableYear, balances, leaveTypes } = await getPersonDetail(ctx, actor, id, yearSchema.parse(query.year)).catch(
    (err: unknown) => {
      if (isDomainError(err, "not_found")) notFound();
      throw err;
    },
  );
  const name = person.name || person.email;
  const yearHref = (y: number) => `/admin/people/${person.id}/allowances?year=${y}`;
  const editable = year >= firstEditableYear;

  return (
    <AdminShell
      userName={userName}
      approvals={approvals}
      section="people"
      title={`Allowances for ${name}`}
      description="Set this person's allowance for a year, or add or take away days with a reason. Days carried over are set by the year rollover."
    >
      <YearNav year={year} min={ALLOWANCE_YEAR_MIN} max={ALLOWANCE_YEAR_MAX} href={yearHref} />
      {!editable && (
        <p className="text-sm text-muted">{year} is closed: allowances can be changed from {firstEditableYear} on.</p>
      )}

      {!balances ? (
        <p className="text-muted">Balances aren&apos;t available: check the company&apos;s allowance policy.</p>
      ) : balances.items.length === 0 ? (
        <p className="text-muted">No active leave types.</p>
      ) : (
        <ul className="space-y-4">
          {balances.items.map(({ leaveTypeId, name: typeName, color, archived, balance, row }) => {
            const settings = leaveTypes.get(leaveTypeId);
            const usage = formatBalanceUsage(balance, year);
            const overdrawn = balance.tracked && balance.remaining < 0;
            const days = row?.days ?? (balance.tracked ? balance.allowance : settings?.defaultAllowanceDays ?? "");
            return (
              <li key={leaveTypeId} className={`${card} space-y-4`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="flex items-center gap-2 font-medium">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />
                    {typeName}
                    {archived && <span className="text-sm font-normal text-muted">(archived)</span>}
                  </h3>
                  <p className="text-right text-sm">
                    <span className={overdrawn ? "font-medium text-red-700 dark:text-red-400" : "font-medium"}>{remainingText(balance)}</span>
                    <span className="block text-muted">
                      {[balance.tracked ? formatBalanceTotal(balance) : null, usage].filter(Boolean).join(" · ")}
                    </span>
                  </p>
                </div>
                {!editable ? null : settings && !settings.countsAgainstAllowance ? (
                  <p className="text-sm text-muted">This leave type doesn&apos;t count against an allowance, so there&apos;s nothing to set.</p>
                ) : (
                  <Reveal label="Change" ariaLabel={`Change ${typeName} allowance`}>
                    <AdminForm action={allowanceAction} submitLabel="Save" pendingLabel="Saving…" buttonClassName={outlineButton} resetOnSuccess>
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
                        <p className="text-sm text-muted">{formatDays(row.carriedOverDays)} carried over from {year - 1} stay as they are.</p>
                      )}
                      <TextField label="Reason" name="reason" required maxLength={NOTE_MAX_LENGTH} hint="Kept in the audit log." />
                      <p className="text-sm text-muted">
                        Setting less than is already booked is allowed; the balance then shows how many days over it is.
                      </p>
                    </AdminForm>
                  </Reveal>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p>
        <Link href={`/admin/people/${person.id}`} className={`${subtleButton} ${focusRing}`}>
          Back to {name}
        </Link>
      </p>
    </AdminShell>
  );
}
