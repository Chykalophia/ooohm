import type { Metadata } from "next";
import { z } from "zod";
import { groupHolidays, HOLIDAY_NAME_MAX_LENGTH, HOLIDAY_RANGE_MAX_DAYS, HOLIDAY_YEAR_MAX, HOLIDAY_YEAR_MIN } from "@/domain/holidays";
import { formatCount, formatLeaveDates, formatLongDate } from "@/lib/format";
import { listHolidaysForAdmin } from "@/server/services/admin-holidays";
import { AdminShell } from "@/app/admin/admin-shell";
import { requireAdminPage } from "@/app/_lib/page-context";
import { Card, Item, ItemList } from "@/components/ui/card";
import { YearNav } from "@/components/navigation/year-nav";
import { TextField } from "@/components/ui/fields";
import { Section } from "@/components/ui/section";
import { ActionForm } from "@/components/forms/action-form";
import { InlineAction } from "@/components/forms/inline-action";
import { Reveal } from "@/components/forms/reveal";
import { outlineButton } from "@/components/ui/styles";
import { addFederalHolidaysAction, addHolidayAction, deleteHolidayAction, renameHolidayAction } from "@/app/admin/holidays/actions";

export const metadata: Metadata = { title: "Holidays · Admin · OOOhm" };

const yearSchema = z.coerce.number().int().min(HOLIDAY_YEAR_MIN).max(HOLIDAY_YEAR_MAX).optional().catch(undefined);

export default async function HolidaysPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { actor, ctx, nav } = await requireAdminPage();
  const { year, holidays } = await listHolidaysForAdmin(ctx, actor, yearSchema.parse((await searchParams).year));
  const yearHref = (y: number) => `/admin/holidays?year=${y}`;
  // Back-to-back days with one name (a shutdown) are one entry here, stored per day.
  const groups = groupHolidays(holidays);

  return (
    <AdminShell
      nav={nav}
      section="holidays"
      title="Holidays"
      description="Holidays never count as leave days. A holiday can be one day or a run of days, like an end-of-year shutdown. Adding or deleting one recounts requests already sent on those dates, this year and later, and emails the people affected."
    >
      <YearNav year={year} min={HOLIDAY_YEAR_MIN} max={HOLIDAY_YEAR_MAX} href={yearHref} />

      <Card aria-label="Add a holiday">
        <ActionForm action={addHolidayAction} submitLabel="Add holiday" pendingLabel="Adding…" resetOnSuccess className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_1fr_2fr]">
            <TextField label="First day" name="date" type="date" required min={`${year}-01-01`} max={`${year}-12-31`} />
            <TextField
              label="Last day"
              name="endDate"
              type="date"
              optional
              min={`${year}-01-01`}
              max={`${year + 1}-12-31`}
              hint={`For a break of several days, up to ${HOLIDAY_RANGE_MAX_DAYS}.`}
            />
            <TextField label="Name" name="name" required maxLength={HOLIDAY_NAME_MAX_LENGTH} autoComplete="off" />
          </div>
        </ActionForm>
      </Card>

      {groups.length === 0 ? (
        <p className="text-muted">No holidays in {year}.</p>
      ) : (
        <ItemList>
          {groups.map((g) => {
            const ids = g.days.map((d) => d.id).join(",");
            const single = g.days.length === 1;
            const when = single ? formatLongDate(g.startDate) : `${formatLeaveDates(g.startDate, g.endDate)} · ${formatCount(g.days.length, "day", "days")}`;
            const onDates = single ? "on that date" : "on those dates";
            return (
              <Item key={g.days[0].id} className="space-y-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium break-words">{g.name}</p>
                  <p className="text-sm text-muted">{when}</p>
                </div>
                <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
                  <Reveal label="Rename" ariaLabel={`Rename ${g.name}`}>
                    <ActionForm action={renameHolidayAction} submitLabel="Save" pendingLabel="Saving…" buttonClassName={outlineButton} className="space-y-3">
                      <input type="hidden" name="ids" value={ids} />
                      <TextField label={`New name for ${g.name}`} name="name" required maxLength={HOLIDAY_NAME_MAX_LENGTH} defaultValue={g.name} />
                    </ActionForm>
                  </Reveal>
                  <InlineAction
                    action={deleteHolidayAction}
                    fields={{ ids }}
                    label="Delete"
                    ariaLabel={`Delete ${g.name}`}
                    pendingLabel="Deleting…"
                    variant="danger"
                    confirm={`Delete ${g.name}? Requests ${onDates}, this year and later, may count ${single ? "it as a working day" : "them as working days"} again.`}
                    confirmLabel="Yes, delete"
                  />
                </div>
              </Item>
            );
          })}
        </ItemList>
      )}

      <Section title="US company?" size="sm" className="space-y-2">
        <InlineAction
          action={addFederalHolidaysAction}
          fields={{ year: String(year) }}
          label={`Add the US federal holidays for ${year}`}
          pendingLabel="Adding…"
          variant="outline"
        />
        <p className="text-sm text-muted">The eleven federal holidays, on the days they&apos;re observed. Dates you already have are left alone.</p>
      </Section>
    </AdminShell>
  );
}
