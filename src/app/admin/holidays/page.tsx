import type { Metadata } from "next";
import { z } from "zod";
import { HOLIDAY_NAME_MAX_LENGTH, HOLIDAY_YEAR_MAX, HOLIDAY_YEAR_MIN } from "@/domain/holidays";
import { formatLongDate } from "@/lib/format";
import { listHolidaysForAdmin } from "@/server/services/admin-holidays";
import { AdminShell, requireAdminPage } from "@/app/admin/admin-shell";
import { YearNav } from "@/app/admin/year-nav";
import { TextField } from "@/app/admin/fields";
import { AdminForm, InlineAction, Reveal } from "@/app/admin/forms";
import { card, outlineButton } from "@/app/admin/styles";
import { addFederalHolidaysAction, addHolidayAction, deleteHolidayAction, renameHolidayAction } from "@/app/admin/holidays/actions";

export const metadata: Metadata = { title: "Holidays · Admin · OOOhm" };

const yearSchema = z.coerce.number().int().min(HOLIDAY_YEAR_MIN).max(HOLIDAY_YEAR_MAX).optional().catch(undefined);

export default async function HolidaysPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { actor, ctx, userName, approvals } = await requireAdminPage();
  const { year, holidays } = await listHolidaysForAdmin(ctx, actor, yearSchema.parse((await searchParams).year));
  const yearHref = (y: number) => `/admin/holidays?year=${y}`;

  return (
    <AdminShell
      userName={userName}
      approvals={approvals}
      section="holidays"
      title="Holidays"
      description="Holidays never count as leave days. Requests already sent keep the days they were counted with."
    >
      <YearNav year={year} min={HOLIDAY_YEAR_MIN} max={HOLIDAY_YEAR_MAX} href={yearHref} />

      <section aria-label="Add a holiday" className={card}>
        <AdminForm action={addHolidayAction} submitLabel="Add holiday" pendingLabel="Adding…" resetOnSuccess className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_2fr]">
            <TextField label="Date" name="date" type="date" required min={`${year}-01-01`} max={`${year}-12-31`} />
            <TextField label="Name" name="name" required maxLength={HOLIDAY_NAME_MAX_LENGTH} autoComplete="off" />
          </div>
        </AdminForm>
      </section>

      {holidays.length === 0 ? (
        <p className="text-muted">No holidays in {year}.</p>
      ) : (
        <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
          {holidays.map((h) => (
            <li key={h.id} className="space-y-3 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium break-words">{h.name}</p>
                <p className="text-sm text-muted">{formatLongDate(h.date)}</p>
              </div>
              <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
                <Reveal label="Rename" ariaLabel={`Rename ${h.name}`}>
                  <AdminForm action={renameHolidayAction} submitLabel="Save" pendingLabel="Saving…" buttonClassName={outlineButton} className="space-y-3">
                    <input type="hidden" name="id" value={h.id} />
                    <TextField label={`New name for ${h.name}`} name="name" required maxLength={HOLIDAY_NAME_MAX_LENGTH} defaultValue={h.name} />
                  </AdminForm>
                </Reveal>
                <InlineAction
                  action={deleteHolidayAction}
                  fields={{ id: h.id }}
                  label="Delete"
                  ariaLabel={`Delete ${h.name}`}
                  pendingLabel="Deleting…"
                  danger
                  confirm={`Delete ${h.name}? Requests already sent keep their days.`}
                  confirmLabel="Yes, delete"
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      <section aria-labelledby="federal-heading" className="space-y-2">
        <h2 id="federal-heading" className="text-sm font-medium">
          US company?
        </h2>
        <InlineAction
          action={addFederalHolidaysAction}
          fields={{ year: String(year) }}
          label={`Add the US federal holidays for ${year}`}
          pendingLabel="Adding…"
          className={outlineButton}
        />
        <p className="text-sm text-muted">The eleven federal holidays, on the days they&apos;re observed. Dates you already have are left alone.</p>
      </section>
    </AdminShell>
  );
}
