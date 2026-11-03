import type { Executor } from "@/db/types";
import { othersOffDuring } from "@/domain/leave-request";
import { teamLabel } from "@/domain/person";
import { formatAlsoOff } from "@/lib/format";
import { listTeamEntries } from "@/server/repositories/calendar";

/**
 * Who else is off during each of `requests`, worded for its approver ("Victor: Mon,
 * Dec 21 to Tue, Dec 22, 2026; Chrismer: Wed, Dec 23, 2026 (afternoon, pending)"), by
 * request id; `null` when nobody is.
 *
 * Shows only what the team calendar already shows every member: active people's
 * approved and pending leave, by name and dates, never a note or a balance. One query
 * for all the requests, over the dates they span together.
 */
export async function alsoOffFor(
  ex: Executor,
  companyId: string,
  requests: readonly { id: string; userId: string; startDate: string; endDate: string }[],
): Promise<Map<string, string | null>> {
  const hints = new Map<string, string | null>();
  if (requests.length === 0) return hints;
  const from = requests.reduce((min, r) => (r.startDate < min ? r.startDate : min), requests[0].startDate);
  const to = requests.reduce((max, r) => (r.endDate > max ? r.endDate : max), requests[0].endDate);
  const entries = await listTeamEntries(ex, companyId, from, to);
  for (const request of requests) {
    const others = othersOffDuring(request, entries).map((e) => ({
      name: teamLabel({ name: e.personName, email: e.personEmail }),
      startDate: e.startDate,
      endDate: e.endDate,
      dayPortion: e.dayPortion,
      pending: e.status === "pending",
    }));
    hints.set(request.id, formatAlsoOff(others));
  }
  return hints;
}
